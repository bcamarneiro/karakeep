# Instagram Content Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a bookmark is an Instagram post/reel/tv URL, extract its caption and (for reels) auto-generated transcript into `bookmarkLinks.htmlContent` so the existing search/summarization pipeline picks it up.

**Architecture:** A dedicated Instagram handler in the crawler worker, analogous to the existing `handleAsAssetBookmark`. It reuses the already-wired `yt-dlp` (run with `--write-info-json --write-auto-subs --skip-download`) plus the existing `CRAWLER_YTDLP_ARGS` cookie config. Pure functions (detect / parse / compose) are TDD'd; the process-spawning and DB-writing glue is verified manually (real Instagram fetch cannot run in CI).

**Tech Stack:** TypeScript, Node (`node:fs`, `node:os`, `node:path`), `execa` (already a dependency, used by `videoWorker`), Drizzle ORM, Vitest, Zod (config).

## Global Constraints

- Package manager: `pnpm`. Run workers tests with `cd apps/workers && pnpm exec vitest run <file>`.
- Feature is **off by default** — `CRAWLER_INSTAGRAM_ENABLED` defaults to `false`. No behavior change for users who do not enable it.
- No DB migration. Reuse the existing `bookmarkLinks.htmlContent` text column.
- No new dependencies. Use `execa` (already used in `apps/workers/workers/videoWorker.ts`).
- Boolean env vars use the `stringBool("false")` helper in `packages/shared/config.ts`.
- yt-dlp extra args split on `%%` (existing `CRAWLER_YTDLP_ARGS` convention).
- Follow existing worker test style: colocated `*.test.ts` files (e.g. `apps/workers/workers/utils/metadataResolver.test.ts`).

---

### Task 1: Instagram URL detection

**Files:**
- Create: `apps/workers/workers/crawler/instagram.ts`
- Test: `apps/workers/workers/crawler/instagram.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `isInstagramUrl(url: string): boolean` — true when the host is `instagram.com` (or a subdomain) and the path is a `p`/`reel`/`reels`/`tv` shortcode. Mirrors `extractInstagramMedia` in `apps/web/.../InstagramRenderer.tsx`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/workers/workers/crawler/instagram.test.ts
import { describe, expect, it } from "vitest";

import { isInstagramUrl } from "./instagram";

describe("isInstagramUrl", () => {
  it("accepts post, reel, reels and tv URLs", () => {
    expect(isInstagramUrl("https://www.instagram.com/p/ABC123/")).toBe(true);
    expect(isInstagramUrl("https://instagram.com/reel/ABC123/")).toBe(true);
    expect(isInstagramUrl("https://www.instagram.com/reels/ABC123")).toBe(true);
    expect(isInstagramUrl("https://www.instagram.com/tv/ABC123/")).toBe(true);
  });

  it("rejects profile, non-instagram and lookalike hosts", () => {
    expect(isInstagramUrl("https://www.instagram.com/someuser/")).toBe(false);
    expect(isInstagramUrl("https://example.com/p/ABC123/")).toBe(false);
    expect(isInstagramUrl("https://instagram.com.evil.com/p/ABC123/")).toBe(
      false,
    );
    expect(isInstagramUrl("not a url")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/workers && pnpm exec vitest run workers/crawler/instagram.test.ts`
Expected: FAIL — `isInstagramUrl` is not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/workers/workers/crawler/instagram.ts
const INSTAGRAM_MEDIA_TYPES = new Set(["p", "reel", "reels", "tv"]);

export function isInstagramUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/(^|\.)instagram\.com$/.test(parsed.hostname)) {
    return false;
  }
  const [type, shortcode] = parsed.pathname.split("/").filter(Boolean);
  return !!shortcode && INSTAGRAM_MEDIA_TYPES.has(type);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/workers && pnpm exec vitest run workers/crawler/instagram.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/workers/workers/crawler/instagram.ts apps/workers/workers/crawler/instagram.test.ts
git commit -m "feat(crawler): detect Instagram media URLs"
```

---

### Task 2: VTT transcript parsing

**Files:**
- Modify: `apps/workers/workers/crawler/instagram.ts`
- Test: `apps/workers/workers/crawler/instagram.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseVtt(vtt: string): string` — strips the `WEBVTT` header, cue indices and timestamp lines, collapses consecutive duplicate text lines, and joins the remaining text with spaces. Returns `""` for empty/headerless input.

- [ ] **Step 1: Write the failing test**

```typescript
// add to apps/workers/workers/crawler/instagram.test.ts
import { isInstagramUrl, parseVtt } from "./instagram";

describe("parseVtt", () => {
  it("extracts spoken text, dropping timestamps and duplicates", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:02.000",
      "hello world",
      "",
      "00:00:02.000 --> 00:00:04.000",
      "hello world",
      "",
      "00:00:04.000 --> 00:00:06.000",
      "second line",
      "",
    ].join("\n");
    expect(parseVtt(vtt)).toBe("hello world second line");
  });

  it("returns empty string for headerless or empty input", () => {
    expect(parseVtt("")).toBe("");
    expect(parseVtt("WEBVTT\n\n")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/workers && pnpm exec vitest run workers/crawler/instagram.test.ts`
Expected: FAIL — `parseVtt` is not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// add to apps/workers/workers/crawler/instagram.ts
export function parseVtt(vtt: string): string {
  const out: string[] = [];
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "WEBVTT") continue;
    if (line.includes("-->")) continue; // timestamp cue
    if (/^\d+$/.test(line)) continue; // numeric cue index
    if (line === out[out.length - 1]) continue; // consecutive duplicate
    out.push(line);
  }
  return out.join(" ");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/workers && pnpm exec vitest run workers/crawler/instagram.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/workers/workers/crawler/instagram.ts apps/workers/workers/crawler/instagram.test.ts
git commit -m "feat(crawler): parse VTT auto-subtitles to plain text"
```

---

### Task 3: Compose the stored HTML

**Files:**
- Modify: `apps/workers/workers/crawler/instagram.ts`
- Test: `apps/workers/workers/crawler/instagram.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface InstagramContent { caption: string; transcript: string; author: string | null; date: string | null; }`
  - `composeInstagramHtml(content: InstagramContent): string` — HTML-escapes all user text, renders the caption as a paragraph, the transcript (when non-empty) under an `<h2>Transcript</h2>`, and an author/date footer line when present.

- [ ] **Step 1: Write the failing test**

```typescript
// add to apps/workers/workers/crawler/instagram.test.ts
import { composeInstagramHtml, isInstagramUrl, parseVtt } from "./instagram";

describe("composeInstagramHtml", () => {
  it("renders caption, transcript and footer, escaping HTML", () => {
    const html = composeInstagramHtml({
      caption: "hi <b>there</b>",
      transcript: "spoken words",
      author: "someuser",
      date: "20260706",
    });
    expect(html).toContain("hi &lt;b&gt;there&lt;/b&gt;");
    expect(html).toContain("<h2>Transcript</h2>");
    expect(html).toContain("spoken words");
    expect(html).toContain("someuser");
    expect(html).toContain("20260706");
  });

  it("omits the transcript section when there is no transcript", () => {
    const html = composeInstagramHtml({
      caption: "just a caption",
      transcript: "",
      author: null,
      date: null,
    });
    expect(html).toContain("just a caption");
    expect(html).not.toContain("<h2>Transcript</h2>");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/workers && pnpm exec vitest run workers/crawler/instagram.test.ts`
Expected: FAIL — `composeInstagramHtml` is not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// add to apps/workers/workers/crawler/instagram.ts
export interface InstagramContent {
  caption: string;
  transcript: string;
  author: string | null;
  date: string | null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function composeInstagramHtml(content: InstagramContent): string {
  const parts: string[] = [];
  if (content.caption) {
    parts.push(`<p>${escapeHtml(content.caption)}</p>`);
  }
  if (content.transcript) {
    parts.push(`<h2>Transcript</h2>`);
    parts.push(`<p>${escapeHtml(content.transcript)}</p>`);
  }
  const footer = [content.author, content.date].filter(Boolean).join(" · ");
  if (footer) {
    parts.push(`<p><small>${escapeHtml(footer)}</small></p>`);
  }
  return parts.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/workers && pnpm exec vitest run workers/crawler/instagram.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/workers/workers/crawler/instagram.ts apps/workers/workers/crawler/instagram.test.ts
git commit -m "feat(crawler): compose Instagram caption + transcript into HTML"
```

---

### Task 4: Parse a yt-dlp dump directory

**Files:**
- Modify: `apps/workers/workers/crawler/instagram.ts`
- Test: `apps/workers/workers/crawler/instagram.test.ts`

**Interfaces:**
- Consumes: `InstagramContent` (Task 3), `parseVtt` (Task 2).
- Produces: `parseInstagramDump(dir: string): Promise<InstagramContent | null>` — reads the first `*.info.json` in `dir` (returns `null` if none), maps `description`→caption, `uploader`/`channel`→author, `upload_date`→date; reads the first `*.vtt` (if any) through `parseVtt` for the transcript.

- [ ] **Step 1: Write the failing test**

```typescript
// add to apps/workers/workers/crawler/instagram.test.ts
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { parseInstagramDump } from "./instagram";

describe("parseInstagramDump", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ig-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when there is no info.json", async () => {
    expect(await parseInstagramDump(dir)).toBeNull();
  });

  it("maps info.json fields and folds in the transcript", async () => {
    await writeFile(
      join(dir, "ig.info.json"),
      JSON.stringify({
        description: "my caption",
        uploader: "someuser",
        upload_date: "20260706",
      }),
    );
    await writeFile(
      join(dir, "ig.en.vtt"),
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello\n",
    );
    expect(await parseInstagramDump(dir)).toEqual({
      caption: "my caption",
      transcript: "hello",
      author: "someuser",
      date: "20260706",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/workers && pnpm exec vitest run workers/crawler/instagram.test.ts`
Expected: FAIL — `parseInstagramDump` is not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// add to apps/workers/workers/crawler/instagram.ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function parseInstagramDump(
  dir: string,
): Promise<InstagramContent | null> {
  const files = await readdir(dir);
  const infoName = files.find((f) => f.endsWith(".info.json"));
  if (!infoName) {
    return null;
  }
  const info = JSON.parse(await readFile(join(dir, infoName), "utf8")) as {
    description?: string;
    uploader?: string;
    channel?: string;
    upload_date?: string;
  };

  const vttName = files.find((f) => f.endsWith(".vtt"));
  const transcript = vttName
    ? parseVtt(await readFile(join(dir, vttName), "utf8"))
    : "";

  return {
    caption: info.description ?? "",
    transcript,
    author: info.uploader ?? info.channel ?? null,
    date: info.upload_date ?? null,
  };
}
```

Put the `node:fs/promises` / `node:path` imports at the top of the file with the other imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/workers && pnpm exec vitest run workers/crawler/instagram.test.ts`
Expected: PASS (all instagram.test.ts tests).

- [ ] **Step 5: Commit**

```bash
git add apps/workers/workers/crawler/instagram.ts apps/workers/workers/crawler/instagram.test.ts
git commit -m "feat(crawler): parse yt-dlp Instagram dump directory"
```

---

### Task 5: Config flag `CRAWLER_INSTAGRAM_ENABLED`

**Files:**
- Modify: `packages/shared/config.ts:116` (add env var near `CRAWLER_VIDEO_DOWNLOAD`) and `packages/shared/config.ts:356` (add to the `crawler` object near `downloadVideo`).

**Interfaces:**
- Produces: `serverConfig.crawler.instagramEnabled: boolean` (default `false`).

- [ ] **Step 1: Add the env var**

In the `zodEnv`/schema object, next to `CRAWLER_VIDEO_DOWNLOAD: stringBool("false"),`, add:

```typescript
  CRAWLER_INSTAGRAM_ENABLED: stringBool("false"),
```

- [ ] **Step 2: Expose it on `serverConfig.crawler`**

In the returned `crawler: { ... }` object, next to `downloadVideo: val.CRAWLER_VIDEO_DOWNLOAD,`, add:

```typescript
      instagramEnabled: val.CRAWLER_INSTAGRAM_ENABLED,
```

- [ ] **Step 3: Verify it typechecks**

Run: `pnpm --filter @karakeep/shared typecheck`
Expected: exit 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/config.ts
git commit -m "feat(config): add CRAWLER_INSTAGRAM_ENABLED flag (default off)"
```

---

### Task 6: `extractInstagramContent` (yt-dlp runner)

**Files:**
- Modify: `apps/workers/workers/crawler/instagram.ts`

**Interfaces:**
- Consumes: `parseInstagramDump` (Task 4), `serverConfig.crawler.ytDlpArguments`, `RunProxyConfig` (from `network`).
- Produces: `extractInstagramContent(url: string, jobId: string, runProxy: RunProxyConfig, abortSignal: AbortSignal): Promise<InstagramContent | null>` — creates a temp dir, runs yt-dlp for metadata + auto-subs (no media download), parses the dump, and always cleans up the temp dir. Returns `null` on any failure.

This task spawns a real process, so it is verified by typecheck + manual run rather than a unit test (a live Instagram fetch cannot run in CI — see Task 8 manual verification).

- [ ] **Step 1: Implement**

```typescript
// add to apps/workers/workers/crawler/instagram.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execa } from "execa";
import type { RunProxyConfig } from "network";
import logger from "@karakeep/shared/logger";
import serverConfig from "@karakeep/shared/config";

export async function extractInstagramContent(
  url: string,
  jobId: string,
  runProxy: RunProxyConfig,
  abortSignal: AbortSignal,
): Promise<InstagramContent | null> {
  const dir = await mkdtemp(join(tmpdir(), "karakeep-ig-"));
  try {
    const proxy = runProxy.httpsProxy ?? runProxy.httpProxy;
    const args = [
      url,
      "--skip-download",
      "--write-info-json",
      "--write-auto-subs",
      "--sub-langs",
      "en.*",
      "--convert-subs",
      "vtt",
      "--no-playlist",
      "-o",
      join(dir, "ig"),
      ...serverConfig.crawler.ytDlpArguments,
      ...(proxy ? ["--proxy", proxy] : []),
    ];
    logger.info(
      `[Crawler][${jobId}] Extracting Instagram content for "${url}" via yt-dlp`,
    );
    await execa("yt-dlp", args, {
      cancelSignal: abortSignal,
      timeout: 60_000,
    });
    return await parseInstagramDump(dir);
  } catch (e) {
    logger.warn(
      `[Crawler][${jobId}] Instagram extraction failed for "${url}": ${e}`,
    );
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

Merge the new imports with the existing ones at the top of the file (do not duplicate `join`, `logger`, etc.).

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm --filter @karakeep/workers typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/workers/workers/crawler/instagram.ts
git commit -m "feat(crawler): fetch Instagram caption + subs via yt-dlp"
```

---

### Task 7: `handleInstagramBookmark` (DB write)

**Files:**
- Modify: `apps/workers/workers/crawler/instagram.ts`

**Interfaces:**
- Consumes: `extractInstagramContent` (Task 6), `composeInstagramHtml` (Task 3), `db`, `bookmarkLinks`, `eq`.
- Produces: `handleInstagramBookmark(args: { url: string; jobId: string; bookmarkId: string; runProxy: RunProxyConfig; abortSignal: AbortSignal; }): Promise<void>` — extracts content, and on success writes `htmlContent`, `title`, `description`, `author`, `crawledAt`, `crawlStatusCode` to `bookmarkLinks`. On failure it writes nothing (the UI embed still renders) and logs.

DB-writing glue — verified by typecheck + manual run (Task 8), not a unit test.

- [ ] **Step 1: Implement**

```typescript
// add to apps/workers/workers/crawler/instagram.ts
import { eq } from "drizzle-orm";
import { db } from "@karakeep/db";
import { bookmarkLinks } from "@karakeep/db/schema";

export async function handleInstagramBookmark(args: {
  url: string;
  jobId: string;
  bookmarkId: string;
  runProxy: RunProxyConfig;
  abortSignal: AbortSignal;
}): Promise<void> {
  const { url, jobId, bookmarkId, runProxy, abortSignal } = args;
  const content = await extractInstagramContent(
    url,
    jobId,
    runProxy,
    abortSignal,
  );
  if (!content) {
    logger.warn(
      `[Crawler][${jobId}] No Instagram content extracted for "${url}"; leaving bookmark as-is`,
    );
    return;
  }
  await db
    .update(bookmarkLinks)
    .set({
      htmlContent: composeInstagramHtml(content),
      title: content.caption ? content.caption.slice(0, 100) : null,
      description: content.caption ? content.caption.slice(0, 300) : null,
      author: content.author,
      crawledAt: new Date(),
      crawlStatusCode: 200,
    })
    .where(eq(bookmarkLinks.id, bookmarkId));
  logger.info(
    `[Crawler][${jobId}] Stored Instagram text content for "${url}"`,
  );
}
```

Merge imports with the existing ones at the top of the file.

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm --filter @karakeep/workers typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/workers/workers/crawler/instagram.ts
git commit -m "feat(crawler): persist extracted Instagram text to bookmarkLinks"
```

---

### Task 8: Hook into `runCrawler` + config docs + manual verification

**Files:**
- Modify: `apps/workers/workers/crawlerWorker.ts` (in `runCrawler`, after `const runProxy = selectRunProxies();` and its `addLogFields`, before the `getContentTypeAndMetadata` probe).
- Modify: `docs/docs/03-configuration.md` (document the new env var).

**Interfaces:**
- Consumes: `isInstagramUrl`, `handleInstagramBookmark` (from `./crawler/instagram`), `enqueuePostCrawlJobs` (existing in `crawlerWorker.ts`), `serverConfig.crawler.instagramEnabled`.

- [ ] **Step 1: Add the import**

At the top of `apps/workers/workers/crawlerWorker.ts`, alongside the other `./crawler/*` imports:

```typescript
import {
  handleInstagramBookmark,
  isInstagramUrl,
} from "./crawler/instagram";
```

- [ ] **Step 2: Add the short-circuit branch**

In `runCrawler`, immediately after the `runProxy` selection + its `addLogFields(...)` call and before the content-type probe (`const { contentType, ... } = ... getContentTypeAndMetadata(...)`), insert:

```typescript
  // Instagram posts hide behind a login wall, so a normal browser crawl yields
  // an empty shell. When enabled, extract caption + transcript via yt-dlp
  // instead, then run the same downstream jobs (inference, search, video).
  if (serverConfig.crawler.instagramEnabled && isInstagramUrl(url)) {
    await handleInstagramBookmark({
      url,
      jobId,
      bookmarkId,
      runProxy,
      abortSignal: job.abortSignal,
    });
    await enqueuePostCrawlJobs(job, bookmarkId, userId, url);
    return { status: "completed" };
  }
```

Note: this early return skips the crawl-latency histogram at the tail of `runCrawler` — acceptable for v1 (the metric is a best-effort observability signal, not correctness).

- [ ] **Step 3: Verify typecheck + full unit suite**

Run: `pnpm --filter @karakeep/workers typecheck && cd apps/workers && pnpm exec vitest run workers/crawler/instagram.test.ts`
Expected: typecheck exit 0; all instagram.test.ts tests PASS.

- [ ] **Step 4: Document the config flag**

In `docs/docs/03-configuration.md`, in the crawler config table, add a row:

```markdown
| CRAWLER_INSTAGRAM_ENABLED | No | false | When enabled, Instagram post/reel URLs are extracted to text (caption + auto-subtitle transcript) via yt-dlp instead of the normal browser crawl. Requires Instagram cookies passed through `CRAWLER_YTDLP_ARGS` (e.g. `--cookies%%/path/to/cookies.txt`). |
```

- [ ] **Step 5: Manual verification (documented, not CI)**

Because a live Instagram fetch needs a logged-in account, verify locally:

1. Export cookies from a logged-in (throwaway) Instagram account to `cookies.txt`.
2. Set `CRAWLER_INSTAGRAM_ENABLED=true` and `CRAWLER_YTDLP_ARGS=--cookies%%/abs/path/cookies.txt`.
3. Start workers (`pnpm workers`) and the web app, bookmark a public reel URL.
4. Confirm the bookmark's stored content (API `GET /bookmarks/{id}?includeContent=true`) has `htmlContent` containing the caption (and transcript for a reel), and that search finds a caption keyword.

Record the outcome in the PR description (the `## How Has This Been Tested?` section).

- [ ] **Step 6: Commit**

```bash
git add apps/workers/workers/crawlerWorker.ts docs/docs/03-configuration.md
git commit -m "feat(crawler): route Instagram bookmarks through text extraction"
```

---

## Notes for the implementer

- Keep all Instagram logic in `instagram.ts`; do not spread it across `crawlAndParse.ts`.
- The pure functions (`isInstagramUrl`, `parseVtt`, `composeInstagramHtml`, `parseInstagramDump`) are the tested core. The process/DB glue (`extractInstagramContent`, `handleInstagramBookmark`, the `runCrawler` hook) is intentionally thin and verified manually.
- Run `pnpm format:fix` before the final commit if the pre-commit hook flags formatting.
