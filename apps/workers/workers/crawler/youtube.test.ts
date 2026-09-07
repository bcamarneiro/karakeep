import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({ execa: vi.fn() }));

const findFirst = vi.fn();
const setCalls: Record<string, unknown>[] = [];
const inserted: Record<string, unknown>[] = [];
const deletedAssetRows: unknown[] = [];

/**
 * Enough of drizzle's builder to record what the append writes. `update`
 * collects the `set()` payload, `insert`/`delete` stand in for the asset row
 * bookkeeping that workerUtils.updateAsset does inside the transaction.
 */
const txn = {
  update: () => ({
    set: (v: Record<string, unknown>) => {
      setCalls.push(v);
      return { where: () => Promise.resolve({ changes: 1 }) };
    },
  }),
  insert: () => ({
    values: (v: Record<string, unknown>) => {
      inserted.push(v);
      return Promise.resolve();
    },
  }),
  delete: () => ({
    where: (w: unknown) => {
      deletedAssetRows.push(w);
      return Promise.resolve();
    },
  }),
};

vi.mock("@karakeep/db", () => ({
  db: {
    query: {
      bookmarkLinks: { findFirst: (...a: unknown[]) => findFirst(...a) },
    },
    transaction: (cb: (t: typeof txn) => Promise<void>) => cb(txn),
  },
}));

vi.mock("@karakeep/shared/assetdb", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    readAsset: vi.fn(),
    saveAsset: vi.fn(),
    getAssetSize: vi.fn(async () => 1),
    newAssetId: vi.fn(() => "new-asset-id"),
    silentDeleteAsset: vi.fn(),
  };
});

const checkStorageQuota = vi.fn(async () => true);

vi.mock("@karakeep/shared-server", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    QuotaService: {
      checkStorageQuota: () => checkStorageQuota(),
    },
  };
});

import { execa } from "execa";
import type { RunProxyConfig } from "network";

import {
  newAssetId,
  readAsset,
  saveAsset,
  silentDeleteAsset,
} from "@karakeep/shared/assetdb";
import serverConfig from "@karakeep/shared/config";

import {
  appendTranscriptHtml,
  appendYouTubeTranscript,
  fetchYouTubeTranscript,
  isYouTubeUrl,
} from "./youtube";

const noProxy: RunProxyConfig = {} as RunProxyConfig;

function vtt(...lines: string[]): string {
  return ["WEBVTT", "", "00:00:01.000 --> 00:00:03.000", ...lines, ""].join(
    "\n",
  );
}

/**
 * Stand in for yt-dlp. `manual` files land on the pass that asks for
 * `--write-subs` only; `auto` files on the pass that adds `--write-auto-subs`.
 */
function ytDlpWrites(opts: {
  manual?: Record<string, string>;
  auto?: Record<string, string>;
  fail?: boolean;
}) {
  vi.mocked(execa).mockImplementation((async (
    _file: string,
    args: string[],
  ) => {
    if (opts.fail) {
      throw new Error("exit 1");
    }
    const outBase = args[args.indexOf("-o") + 1];
    const files = args.includes("--write-auto-subs")
      ? (opts.auto ?? {})
      : (opts.manual ?? {});
    for (const [name, body] of Object.entries(files)) {
      await writeFile(join(dirname(outBase), name), body);
    }
    return {};
  }) as unknown as typeof execa);
}

beforeEach(() => {
  vi.clearAllMocks();
  setCalls.length = 0;
  inserted.length = 0;
  deletedAssetRows.length = 0;
  serverConfig.crawler.youtubeSubLangs = "pt.*,en.*";
});

describe("isYouTubeUrl", () => {
  it("accepts watch, youtu.be and shorts URLs", () => {
    expect(isYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      true,
    );
    expect(isYouTubeUrl("https://youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
    expect(isYouTubeUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
    expect(isYouTubeUrl("https://www.youtube.com/shorts/abc123")).toBe(true);
    expect(isYouTubeUrl("https://m.youtube.com/watch?v=abc123")).toBe(true);
  });

  it("rejects non-video, non-youtube and lookalike hosts", () => {
    expect(isYouTubeUrl("https://www.youtube.com/@somechannel")).toBe(false);
    expect(isYouTubeUrl("https://www.youtube.com/watch")).toBe(false);
    expect(isYouTubeUrl("https://youtube.com.evil.com/watch?v=abc")).toBe(
      false,
    );
    expect(isYouTubeUrl("https://notyoutube.com/watch?v=abc")).toBe(false);
    expect(isYouTubeUrl("https://youtu.be/")).toBe(false);
    expect(isYouTubeUrl("not a url")).toBe(false);
  });
});

describe("fetchYouTubeTranscript", () => {
  it("prefers a manual pt track over an auto en one", async () => {
    ytDlpWrites({
      manual: { "yt.pt.vtt": vtt("olá mundo") },
      auto: { "yt.en.vtt": vtt("hello world") },
    });
    const res = await fetchYouTubeTranscript(
      "https://www.youtube.com/watch?v=x",
      "job1",
      noProxy,
      new AbortController().signal,
    );
    expect(res).toEqual({
      transcript: "olá mundo",
      source: "manual",
      lang: "pt",
    });
    // The auto pass is not even attempted once manual subs exist.
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(1);
  });

  it("honours the configured language order among manual tracks", async () => {
    ytDlpWrites({
      manual: {
        "yt.en.vtt": vtt("hello world"),
        "yt.pt-BR.vtt": vtt("olá mundo"),
      },
    });
    const res = await fetchYouTubeTranscript(
      "https://www.youtube.com/watch?v=x",
      "job1",
      noProxy,
      new AbortController().signal,
    );
    expect(res.lang).toBe("pt-BR");
    expect(res.transcript).toBe("olá mundo");
  });

  it("falls back to auto subs when there are no manual ones", async () => {
    ytDlpWrites({ auto: { "yt.en.vtt": vtt("hello world") } });
    const res = await fetchYouTubeTranscript(
      "https://www.youtube.com/watch?v=x",
      "job1",
      noProxy,
      new AbortController().signal,
    );
    expect(res).toEqual({
      transcript: "hello world",
      source: "auto",
      lang: "en",
    });
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(2);
  });

  it("does not let an empty preferred track shadow a usable auto one", async () => {
    // YouTube serves position-only or empty cues for some videos. A pt track
    // that parses to nothing must not hide the en auto track that has text —
    // and the leftover pt file must not be picked up by the auto pass either.
    ytDlpWrites({
      manual: { "yt.pt.vtt": "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n\n" },
      auto: { "yt.en.vtt": vtt("hello world") },
    });
    const res = await fetchYouTubeTranscript(
      "https://www.youtube.com/watch?v=x",
      "job1",
      noProxy,
      new AbortController().signal,
    );
    expect(res).toEqual({
      transcript: "hello world",
      source: "auto",
      lang: "en",
    });
  });

  it("falls back to a lesser-preferred track that actually has text", async () => {
    ytDlpWrites({
      manual: {
        "yt.pt.vtt": "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n\n",
        "yt.en.vtt": vtt("hello world"),
      },
    });
    const res = await fetchYouTubeTranscript(
      "https://www.youtube.com/watch?v=x",
      "job1",
      noProxy,
      new AbortController().signal,
    );
    expect(res).toEqual({
      transcript: "hello world",
      source: "manual",
      lang: "en",
    });
  });

  it("reports none when yt-dlp writes nothing", async () => {
    ytDlpWrites({});
    const res = await fetchYouTubeTranscript(
      "https://www.youtube.com/watch?v=x",
      "job1",
      noProxy,
      new AbortController().signal,
    );
    expect(res).toEqual({ transcript: "", source: "none", lang: null });
  });

  it("reports none instead of throwing when yt-dlp fails", async () => {
    ytDlpWrites({ fail: true });
    await expect(
      fetchYouTubeTranscript(
        "https://www.youtube.com/watch?v=x",
        "job1",
        noProxy,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ transcript: "", source: "none", lang: null });
  });

  it("passes the configured yt-dlp arguments and the proxy through", async () => {
    ytDlpWrites({ manual: { "yt.pt.vtt": vtt("olá") } });
    const before = serverConfig.crawler.ytDlpArguments;
    serverConfig.crawler.ytDlpArguments = ["--sleep-requests", "1"];
    try {
      await fetchYouTubeTranscript(
        "https://www.youtube.com/watch?v=x",
        "job1",
        { httpsProxy: "http://proxy:8080" } as RunProxyConfig,
        new AbortController().signal,
      );
    } finally {
      serverConfig.crawler.ytDlpArguments = before;
    }
    const args = vi.mocked(execa).mock.calls[0][1] as string[];
    expect(args).toContain("--skip-download");
    expect(args).toContain("--write-subs");
    expect(args).not.toContain("--write-auto-subs");
    expect(args).toEqual(
      expect.arrayContaining(["--sleep-requests", "1", "--proxy"]),
    );
    expect(args.slice(-2)).toEqual(["--", "https://www.youtube.com/watch?v=x"]);
  });
});

describe("appendTranscriptHtml", () => {
  it("escapes HTML and appends after the existing content", () => {
    expect(appendTranscriptHtml("<p>page</p>", "a < b & c > d")).toBe(
      "<p>page</p>\n<h2>Transcript</h2>\n<p>a &lt; b &amp; c &gt; d</p>",
    );
  });

  it("stands alone when there is no existing content", () => {
    expect(appendTranscriptHtml(null, "hi")).toBe(
      "<h2>Transcript</h2>\n<p>hi</p>",
    );
  });
});

describe("appendYouTubeTranscript", () => {
  it("appends to inline content and leaves it inline", async () => {
    findFirst.mockResolvedValue({
      htmlContent: "<p>page</p>",
      contentAssetId: null,
    });
    const ok = await appendYouTubeTranscript({
      bookmarkId: "bm1",
      userId: "u1",
      jobId: "job1",
      transcript: "spoken <words>",
    });
    expect(ok).toBe(true);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]).toMatchObject({
      htmlContent:
        "<p>page</p>\n<h2>Transcript</h2>\n<p>spoken &lt;words&gt;</p>",
      contentAssetId: null,
    });
    expect(vi.mocked(saveAsset)).not.toHaveBeenCalled();
  });

  it("reads, appends to and re-stores content that lives in an asset", async () => {
    vi.mocked(readAsset).mockResolvedValue({
      asset: Buffer.from("<p>big page</p>", "utf8"),
    } as unknown as Awaited<ReturnType<typeof readAsset>>);
    findFirst.mockResolvedValue({
      htmlContent: null,
      contentAssetId: "old-asset-id",
    });
    // Force the asset path regardless of the appended size.
    const before = serverConfig.crawler.htmlContentSizeThreshold;
    serverConfig.crawler.htmlContentSizeThreshold = 1;
    try {
      const ok = await appendYouTubeTranscript({
        bookmarkId: "bm1",
        userId: "u1",
        jobId: "job1",
        transcript: "spoken words",
      });
      expect(ok).toBe(true);
    } finally {
      serverConfig.crawler.htmlContentSizeThreshold = before;
    }
    expect(vi.mocked(readAsset)).toHaveBeenCalledWith({
      userId: "u1",
      assetId: "old-asset-id",
    });
    const saved = vi.mocked(saveAsset).mock.calls[0][0];
    expect((saved.asset as Buffer).toString("utf8")).toBe(
      "<p>big page</p>\n<h2>Transcript</h2>\n<p>spoken words</p>",
    );
    expect(setCalls[0]).toMatchObject({
      htmlContent: null,
      contentAssetId: "new-asset-id",
    });
    expect(vi.mocked(newAssetId)).toHaveBeenCalled();
    // The asset row is repointed and the superseded blob deleted.
    expect(inserted[0]).toMatchObject({ id: "new-asset-id", userId: "u1" });
    expect(vi.mocked(silentDeleteAsset)).toHaveBeenCalledWith(
      "u1",
      "old-asset-id",
    );
  });

  it("writes nothing when the content could not be stored", async () => {
    findFirst.mockResolvedValue({
      htmlContent: "<p>page</p>",
      contentAssetId: null,
    });
    // A quota failure makes storeHtmlContent report not_stored; the crawled
    // content must survive untouched rather than be nulled out.
    const before = serverConfig.crawler.htmlContentSizeThreshold;
    serverConfig.crawler.htmlContentSizeThreshold = 1;
    checkStorageQuota.mockRejectedValueOnce(new Error("over quota"));
    try {
      const ok = await appendYouTubeTranscript({
        bookmarkId: "bm1",
        userId: "u1",
        jobId: "job1",
        transcript: "spoken words",
      });
      expect(ok).toBe(false);
    } finally {
      serverConfig.crawler.htmlContentSizeThreshold = before;
    }
    expect(setCalls).toHaveLength(0);
  });

  it("does nothing for a bookmark that is not there", async () => {
    findFirst.mockResolvedValue(undefined);
    const ok = await appendYouTubeTranscript({
      bookmarkId: "gone",
      userId: "u1",
      jobId: "job1",
      transcript: "spoken words",
    });
    expect(ok).toBe(false);
    expect(setCalls).toHaveLength(0);
  });
});
