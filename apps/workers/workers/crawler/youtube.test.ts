import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({ execa: vi.fn() }));

const findFirst = vi.fn();
const setCalls: Record<string, unknown>[] = [];
const inserted: Record<string, unknown>[] = [];
const deletedAssetRows: unknown[] = [];

/**
 * Enough of drizzle's builder to record what the store writes. `update`
 * collects the `set()` payload, `insert`/`delete` stand in for the asset row
 * bookkeeping that workerUtils.updateAsset does inside the transaction.
 */
const builder = {
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
    // Both deferred: the factory runs before `builder` is initialised.
    update: () => builder.update(),
    transaction: (cb: (t: typeof builder) => Promise<void>) => cb(builder),
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
  saveAsset,
  silentDeleteAsset,
} from "@karakeep/shared/assetdb";
import serverConfig from "@karakeep/shared/config";

import type { YouTubeContent } from "./youtube";
import {
  composeYouTubeHtml,
  extractYouTubeContent,
  formatTimestamp,
  handleYouTubeBookmark,
  isRealYtDlpFailure,
  isYouTubeUrl,
  parseInfoJson,
} from "./youtube";

const noProxy: RunProxyConfig = {} as RunProxyConfig;
const signal = () => new AbortController().signal;

function vtt(...lines: string[]): string {
  return ["WEBVTT", "", "00:00:01.000 --> 00:00:03.000", ...lines, ""].join(
    "\n",
  );
}

const INFO = {
  title: "How it works",
  description: "First line.\nSecond line.\n\nA new paragraph.",
  uploader: "Some Channel",
  upload_date: "20260115",
  duration: 610,
  chapters: [
    { title: "Intro", start_time: 0 },
    { title: "The meat", start_time: 65 },
  ],
  // yt-dlp lists every auto-caption language in the info.json; the second
  // pass is only worth running when one of them is a language we asked for.
  automatic_captions: { en: [{ ext: "vtt" }], pt: [{ ext: "vtt" }] },
};

/**
 * Stand in for yt-dlp. The pass carrying `--write-info-json` gets the
 * info.json and the `manual` subtitle files; the pass carrying
 * `--write-auto-subs` gets the `auto` ones.
 */
function ytDlpWrites(opts: {
  info?: Record<string, unknown> | null;
  manual?: Record<string, string>;
  auto?: Record<string, string>;
  fail?: boolean;
  /** Write everything, then exit non-zero with this on stderr. */
  stderrFail?: string;
  /** Called before each pass; used to abort mid-run. */
  onPass?: (auto: boolean) => void;
}) {
  vi.mocked(execa).mockImplementation((async (
    _file: string,
    args: string[],
  ) => {
    if (opts.fail) {
      throw new Error("exit 1");
    }
    const dir = dirname(args[args.indexOf("-o") + 1]);
    const auto = args.includes("--write-auto-subs");
    opts.onPass?.(auto);
    if (args.includes("--write-info-json")) {
      const info = opts.info === undefined ? INFO : opts.info;
      if (info !== null) {
        await writeFile(join(dir, "yt.info.json"), JSON.stringify(info));
      }
    }
    for (const [name, body] of Object.entries(
      (auto ? opts.auto : opts.manual) ?? {},
    )) {
      await writeFile(join(dir, name), body);
    }
    if (opts.stderrFail !== undefined) {
      throw Object.assign(new Error("exit 1"), { stderr: opts.stderrFail });
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
    expect(isYouTubeUrl("https://www.youtube.com/live/abc123")).toBe(true);
    expect(isYouTubeUrl("https://www.youtube.com/embed/abc123")).toBe(true);
  });

  it("rejects non-video, non-youtube and lookalike hosts", () => {
    expect(isYouTubeUrl("https://www.youtube.com/@somechannel")).toBe(false);
    expect(isYouTubeUrl("https://www.youtube.com/watch")).toBe(false);
    expect(isYouTubeUrl("https://youtube.com.evil.com/watch?v=abc")).toBe(
      false,
    );
    expect(isYouTubeUrl("https://notyoutube.com/watch?v=abc")).toBe(false);
    expect(isYouTubeUrl("https://youtu.be/")).toBe(false);
    // A playlist wearing an embed URL: no single video to describe.
    expect(
      isYouTubeUrl("https://www.youtube.com/embed/videoseries?list=PL123"),
    ).toBe(false);
    expect(isYouTubeUrl("not a url")).toBe(false);
  });
});

describe("parseInfoJson", () => {
  it("reads title, description, channel, date, chapters and duration", () => {
    expect(parseInfoJson(JSON.stringify(INFO))).toEqual({
      title: "How it works",
      description: "First line.\nSecond line.\n\nA new paragraph.",
      channel: "Some Channel",
      uploadDate: "20260115",
      durationSec: 610,
      chapters: [
        { title: "Intro", startTime: 0 },
        { title: "The meat", startTime: 65 },
      ],
      autoCaptionLangs: ["en", "pt"],
    });
  });

  it("defaults every optional field and falls back to `channel`", () => {
    expect(parseInfoJson(JSON.stringify({ channel: "Fallback" }))).toEqual({
      title: "",
      description: "",
      channel: "Fallback",
      uploadDate: null,
      chapters: [],
      durationSec: null,
      autoCaptionLangs: [],
    });
  });

  it("drops chapters without a start time, and returns null on bad JSON", () => {
    const parsed = parseInfoJson(
      JSON.stringify({ chapters: [{ title: "no start" }, { start_time: 12 }] }),
    );
    expect(parsed?.chapters).toEqual([{ title: "", startTime: 12 }]);
    expect(parseInfoJson("not json")).toBeNull();
  });
});

describe("extractYouTubeContent", () => {
  it("returns metadata and the manual track from a single yt-dlp pass", async () => {
    ytDlpWrites({ manual: { "yt.pt.vtt": vtt("olá mundo") } });
    const res = await extractYouTubeContent(
      "https://www.youtube.com/watch?v=x",
      "job1",
      noProxy,
      signal(),
    );
    expect(res).toMatchObject({
      title: "How it works",
      channel: "Some Channel",
      uploadDate: "20260115",
      transcript: "olá mundo",
      subs: "manual",
      lang: "pt",
      failed: false,
    });
    expect(res?.chapters).toHaveLength(2);
    // Metadata and manual subs come from one invocation.
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(1);
    const args = vi.mocked(execa).mock.calls[0][1] as string[];
    expect(args).toContain("--write-info-json");
    expect(args).toContain("--skip-download");
    expect(args).toContain("--write-subs");
    expect(args).not.toContain("--write-auto-subs");
  });

  it("runs a second pass for auto captions only when there are no manual ones", async () => {
    // yt-dlp's real output name for `-o <dir>/yt` is unverified until the
    // e2e, so the language must be read off any `.vtt`, not an assumed prefix.
    ytDlpWrites({
      auto: { "Some Video Title [abc123].en.vtt": vtt("hello world") },
    });
    const res = await extractYouTubeContent(
      "https://www.youtube.com/watch?v=x",
      "job1",
      noProxy,
      signal(),
    );
    expect(res).toMatchObject({
      title: "How it works",
      transcript: "hello world",
      subs: "auto",
      lang: "en",
      failed: false,
    });
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(2);
    const second = vi.mocked(execa).mock.calls[1][1] as string[];
    expect(second).toContain("--write-auto-subs");
    expect(second).not.toContain("--write-info-json");
  });

  it("skips the auto pass when the video has no caption language we asked for", async () => {
    // The info.json already says which auto captions exist; when none of them
    // matches, a second request to YouTube could only come back empty.
    ytDlpWrites({ info: { ...INFO, automatic_captions: { fr: [] } } });
    const res = await extractYouTubeContent(
      "https://www.youtube.com/watch?v=x",
      "job1",
      noProxy,
      signal(),
    );
    expect(res).toMatchObject({ subs: "none", lang: null, failed: false });
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(1);
  });

  it("honours the configured language order among manual tracks", async () => {
    ytDlpWrites({
      manual: {
        "yt.en.vtt": vtt("hello world"),
        "yt.pt-BR.vtt": vtt("olá mundo"),
      },
    });
    const res = await extractYouTubeContent(
      "https://www.youtube.com/watch?v=x",
      "job1",
      noProxy,
      signal(),
    );
    expect(res?.lang).toBe("pt-BR");
    expect(res?.transcript).toBe("olá mundo");
  });

  it("does not let an empty preferred track shadow a usable auto one", async () => {
    // YouTube serves position-only or empty cues for some videos. A pt track
    // that parses to nothing must not hide the en auto track that has text —
    // and the leftover pt file must not be picked up by the auto pass either.
    ytDlpWrites({
      manual: { "yt.pt.vtt": "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n\n" },
      auto: { "yt.en.vtt": vtt("hello world") },
    });
    const res = await extractYouTubeContent(
      "https://www.youtube.com/watch?v=x",
      "job1",
      noProxy,
      signal(),
    );
    expect(res).toMatchObject({
      transcript: "hello world",
      subs: "auto",
      lang: "en",
    });
  });

  it("keeps the metadata when the video simply has no subtitles", async () => {
    ytDlpWrites({});
    const res = await extractYouTubeContent(
      "https://www.youtube.com/watch?v=x",
      "job1",
      noProxy,
      signal(),
    );
    // No subtitles is a normal outcome, so nothing failed.
    expect(res).toMatchObject({
      title: "How it works",
      transcript: "",
      subs: "none",
      lang: null,
      failed: false,
    });
  });

  it("a non-zero exit that only says 'no subtitles' is not a failure", async () => {
    ytDlpWrites({
      stderrFail:
        "WARNING: [youtube] abc: There are no subtitles for the requested languages",
    });
    const res = await extractYouTubeContent(
      "https://www.youtube.com/watch?v=x",
      "job1",
      noProxy,
      signal(),
    );
    expect(res).toMatchObject({ subs: "none", failed: false });
  });

  it("a non-zero exit that says the request was throttled is a failure", async () => {
    ytDlpWrites({ stderrFail: "ERROR: HTTP Error 429: Too Many Requests" });
    const res = await extractYouTubeContent(
      "https://www.youtube.com/watch?v=x",
      "job1",
      noProxy,
      signal(),
    );
    expect(res).toMatchObject({ subs: "none", failed: true });
  });

  it("propagates an abort raised during the second pass", async () => {
    const controller = new AbortController();
    ytDlpWrites({
      auto: { "yt.en.vtt": vtt("hello world") },
      onPass: (auto) => {
        if (auto) {
          controller.abort();
        }
      },
    });
    // A cancelled job must reject, not quietly store half a transcript.
    await expect(
      extractYouTubeContent(
        "https://www.youtube.com/watch?v=x",
        "job1",
        noProxy,
        controller.signal,
      ),
    ).rejects.toThrow();
  });

  it("returns null when yt-dlp writes no info.json at all", async () => {
    ytDlpWrites({ info: null });
    await expect(
      extractYouTubeContent(
        "https://www.youtube.com/watch?v=x",
        "job1",
        noProxy,
        signal(),
      ),
    ).resolves.toBeNull();
  });

  it("returns null when yt-dlp fails outright", async () => {
    ytDlpWrites({ fail: true });
    await expect(
      extractYouTubeContent(
        "https://www.youtube.com/watch?v=x",
        "job1",
        noProxy,
        signal(),
      ),
    ).resolves.toBeNull();
  });

  it("passes the configured yt-dlp arguments and the proxy through", async () => {
    ytDlpWrites({ manual: { "yt.pt.vtt": vtt("olá") } });
    const before = serverConfig.crawler.ytDlpArguments;
    serverConfig.crawler.ytDlpArguments = ["--sleep-requests", "1"];
    try {
      await extractYouTubeContent(
        "https://www.youtube.com/watch?v=x",
        "job1",
        { httpsProxy: "http://proxy:8080" } as RunProxyConfig,
        signal(),
      );
    } finally {
      serverConfig.crawler.ytDlpArguments = before;
    }
    const args = vi.mocked(execa).mock.calls[0][1] as string[];
    expect(args).toEqual(
      expect.arrayContaining(["--sleep-requests", "1", "--proxy"]),
    );
    expect(args.slice(-2)).toEqual(["--", "https://www.youtube.com/watch?v=x"]);
  });

  it("hands yt-dlp a private copy of the cookie jar, never the configured one", async () => {
    // yt-dlp rewrites the jar it is given, so a YouTube pass pointed at the
    // shared jar writes .youtube.com cookies into Instagram's session file.
    ytDlpWrites({ manual: { "yt.pt.vtt": vtt("olá") } });
    const jarDir = await mkdtemp(join(tmpdir(), "karakeep-yt-jar-"));
    const jar = join(jarDir, "instagram.txt");
    await writeFile(jar, "# Netscape HTTP Cookie File\n");
    const before = serverConfig.crawler.ytDlpArguments;
    serverConfig.crawler.ytDlpArguments = ["--cookies", jar];
    try {
      await extractYouTubeContent(
        "https://www.youtube.com/watch?v=x",
        "job1",
        noProxy,
        signal(),
      );
    } finally {
      serverConfig.crawler.ytDlpArguments = before;
      await rm(jarDir, { recursive: true, force: true });
    }
    const args = vi.mocked(execa).mock.calls[0][1] as string[];
    const passDir = dirname(args[args.indexOf("-o") + 1]);
    expect(args[args.indexOf("--cookies") + 1]).toBe(
      join(passDir, "cookies.txt"),
    );
  });
});

describe("isRealYtDlpFailure", () => {
  it("treats throttling, server errors and generic errors as failures", () => {
    expect(isRealYtDlpFailure("ERROR: HTTP Error 429: Too Many Requests")).toBe(
      true,
    );
    expect(
      isRealYtDlpFailure("ERROR: HTTP Error 503: Service Unavailable"),
    ).toBe(true);
    expect(
      isRealYtDlpFailure("ERROR: Sign in to confirm you're not a bot"),
    ).toBe(true);
    expect(isRealYtDlpFailure("WARNING: Unable to download webpage")).toBe(
      true,
    );
  });

  it("does not treat a video without the requested captions as a failure", () => {
    expect(
      isRealYtDlpFailure(
        "WARNING: [youtube] abc123: There are no subtitles for the requested languages",
      ),
    ).toBe(false);
    expect(isRealYtDlpFailure("WARNING: video has no subtitles")).toBe(false);
    expect(isRealYtDlpFailure("WARNING: there are no automatic captions")).toBe(
      false,
    );
  });

  it("classifies line by line, and calls a silent non-zero exit a failure", () => {
    // A "no subtitles" notice on one line must not excuse an ERROR on another.
    expect(
      isRealYtDlpFailure(
        "WARNING: There are no subtitles for the requested languages\nERROR: HTTP Error 429",
      ),
    ).toBe(true);
    // ENOENT and the execa timeout leave nothing on stderr; both are real.
    expect(isRealYtDlpFailure(undefined)).toBe(true);
    expect(isRealYtDlpFailure("   ")).toBe(true);
  });
});

describe("formatTimestamp", () => {
  it("is mm:ss, and h:mm:ss past the first hour", () => {
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(65)).toBe("1:05");
    expect(formatTimestamp(610)).toBe("10:10");
    expect(formatTimestamp(3661)).toBe("1:01:01");
  });
});

const CONTENT: YouTubeContent = {
  title: "Tom & Jerry <live>",
  description: "First line.\nSecond line.\n\nA <new> paragraph.",
  channel: "Some Channel",
  uploadDate: "20260115",
  durationSec: 610,
  chapters: [
    { title: "Intro", startTime: 0 },
    { title: "The <meat>", startTime: 65 },
  ],
  transcript: "a < b & c",
  subs: "manual",
  lang: "pt",
  failed: false,
};

describe("composeYouTubeHtml", () => {
  it("lays out title, description, chapters, transcript, footer and marker", () => {
    expect(composeYouTubeHtml(CONTENT)).toBe(
      [
        "<h1>Tom &amp; Jerry &lt;live&gt;</h1>",
        "<p>First line.<br>Second line.</p>",
        "<p>A &lt;new&gt; paragraph.</p>",
        "<h2>Chapters</h2>",
        "<ul>",
        "<li>0:00 – Intro</li>",
        "<li>1:05 – The &lt;meat&gt;</li>",
        "</ul>",
        "<h2>Transcript</h2>",
        "<p>a &lt; b &amp; c</p>",
        "<p><small>Some Channel · 2026-01-15</small></p>",
        "<!-- karakeep-yt subs=manual lang=pt status=ok -->",
      ].join("\n"),
    );
  });

  it("omits the sections it has nothing for and marks a failed sub fetch", () => {
    const html = composeYouTubeHtml({
      ...CONTENT,
      description: "",
      chapters: [],
      transcript: "",
      subs: "none",
      lang: null,
      failed: true,
    });
    expect(html).not.toContain("<h2>Chapters</h2>");
    expect(html).not.toContain("<h2>Transcript</h2>");
    expect(html).toContain("<h1>Tom &amp; Jerry &lt;live&gt;</h1>");
    expect(html).toContain(
      "<!-- karakeep-yt subs=none lang=none status=partial -->",
    );
  });
});

describe("handleYouTubeBookmark", () => {
  const call = () =>
    handleYouTubeBookmark({
      url: "https://www.youtube.com/watch?v=x",
      jobId: "job1",
      bookmarkId: "bm1",
      userId: "u1",
      runProxy: noProxy,
      abortSignal: signal(),
    });

  it("stores the composed content inline and sets title, description and author", async () => {
    findFirst.mockResolvedValue({ contentAssetId: null });
    ytDlpWrites({ manual: { "yt.pt.vtt": vtt("olá mundo") } });

    await expect(call()).resolves.toBe(true);

    expect(setCalls).toHaveLength(1);
    const written = setCalls[0];
    expect(written).toMatchObject({
      title: "How it works",
      description: "First line.\nSecond line.\n\nA new paragraph.",
      author: "Some Channel",
      crawlStatusCode: 200,
      contentAssetId: null,
    });
    expect(written.crawledAt).toBeInstanceOf(Date);
    expect(written.htmlContent).toContain("<h1>How it works</h1>");
    expect(written.htmlContent).toContain("<h2>Chapters</h2>");
    expect(written.htmlContent).toContain("<p>olá mundo</p>");
    expect(vi.mocked(saveAsset)).not.toHaveBeenCalled();
  });

  it("falls back to the transcript for the description when there is none", async () => {
    findFirst.mockResolvedValue({ contentAssetId: null });
    ytDlpWrites({
      info: { ...INFO, description: "" },
      manual: { "yt.pt.vtt": vtt("olá mundo") },
    });
    await call();
    expect(setCalls[0]).toMatchObject({ description: "olá mundo" });
  });

  it("stores large content as an asset, superseding the previous one", async () => {
    findFirst.mockResolvedValue({ contentAssetId: "old-asset-id" });
    ytDlpWrites({ manual: { "yt.pt.vtt": vtt("olá mundo") } });
    const before = serverConfig.crawler.htmlContentSizeThreshold;
    serverConfig.crawler.htmlContentSizeThreshold = 1;
    try {
      await expect(call()).resolves.toBe(true);
    } finally {
      serverConfig.crawler.htmlContentSizeThreshold = before;
    }
    expect(setCalls[0]).toMatchObject({
      htmlContent: null,
      contentAssetId: "new-asset-id",
    });
    expect(vi.mocked(newAssetId)).toHaveBeenCalled();
    expect(inserted[0]).toMatchObject({ id: "new-asset-id", userId: "u1" });
    expect(vi.mocked(silentDeleteAsset)).toHaveBeenCalledWith(
      "u1",
      "old-asset-id",
    );
  });

  it("keeps the metadata but not the content when the store is refused", async () => {
    findFirst.mockResolvedValue({ contentAssetId: null });
    ytDlpWrites({ manual: { "yt.pt.vtt": vtt("olá mundo") } });
    const before = serverConfig.crawler.htmlContentSizeThreshold;
    serverConfig.crawler.htmlContentSizeThreshold = 1;
    checkStorageQuota.mockRejectedValueOnce(new Error("over quota"));
    try {
      // Still handled: the metadata is worth having, and falling through to
      // the browser crawl would only crash Chrome.
      await expect(call()).resolves.toBe(true);
    } finally {
      serverConfig.crawler.htmlContentSizeThreshold = before;
    }
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]).toMatchObject({ title: "How it works" });
    // The content columns are left exactly as they were.
    expect(setCalls[0]).not.toHaveProperty("htmlContent");
    expect(setCalls[0]).not.toHaveProperty("contentAssetId");
  });

  it("reports not handled when yt-dlp yields nothing, so the caller can fall back", async () => {
    ytDlpWrites({ info: null });
    await expect(call()).resolves.toBe(false);
    expect(setCalls).toHaveLength(0);
  });

  it("does nothing for a bookmark that is gone", async () => {
    findFirst.mockResolvedValue(undefined);
    ytDlpWrites({ manual: { "yt.pt.vtt": vtt("olá mundo") } });
    // Extraction worked, so the URL is still considered handled; there is
    // simply no row left to write to.
    await expect(call()).resolves.toBe(true);
    expect(setCalls).toHaveLength(0);
  });
});
