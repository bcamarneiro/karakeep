# Instagram content extraction → searchable text

**Date:** 2026-07-06
**Status:** Design approved, pending spec review

## Problem

When a user bookmarks an Instagram URL (post / reel / tv), karakeep stores
almost no usable text. The normal browser crawl hits Instagram's login wall and
returns an empty shell, so `bookmarkLinks.htmlContent` ends up empty. The
existing `InstagramRenderer` shows the official `embed/captioned` iframe in the
UI, but that is display-only: the caption is never stored, so it is **not
searchable, not summarizable, and disappears if the post is deleted or made
private**.

Goal: extract the textual content of an Instagram bookmark (caption +, for
reels, the auto-generated transcript) into `htmlContent`, so the existing
search / summarization / tagging / embedding pipeline picks it up.

## What already exists (reused, not rebuilt)

- **yt-dlp** is already wired in `apps/workers/workers/videoWorker.ts`
  (`prepareYtDlpArguments`), and extra flags flow through the existing
  `CRAWLER_YTDLP_ARGS` config — so cookies (`--cookies` /
  `--cookies-from-browser`) can already be injected without code changes.
- **Instagram URL detection** exists in
  `apps/web/components/dashboard/preview/content-renderers/InstagramRenderer.tsx`
  (`extractInstagramMedia` → `{ type, shortcode }`). The same shape is reused
  server-side.
- **Inference** (summarization, tagging, embeddings) already runs on
  `htmlContent`, so nothing new is needed downstream.

## Non-goals (v1)

- **No vision / OCR** of static image posts (text baked into images). Deferred
  to a later tier.
- **No stories.** They expire in 24h and almost always require following the
  account; out of scope.
- **No change to video download.** The existing `videoWorker` keeps handling the
  media file; this feature only produces text.

## Approach

A dedicated Instagram handler in the crawler flow, analogous to the existing
`handleAsAssetBookmark`.

### Flow

1. **Detect** — in `runCrawler` (`crawlerWorker.ts`), before the normal
   content-type probe / browser crawl, check `isInstagramUrl(url)`. If it
   matches *and* `serverConfig.crawler.instagramEnabled` is on, route to the
   Instagram handler and skip the normal crawl.
2. **Fetch** — run yt-dlp with `--write-info-json --write-auto-subs
   --skip-download`, plus the configured `CRAWLER_YTDLP_ARGS` (cookies) and the
   run proxy, into a temp dir.
3. **Parse** — from the `.info.json`: `description` (caption), `uploader` /
   `channel` (author), `upload_date`, `title`. From the `.vtt` subtitle file (if
   present): the transcript, de-duplicated and stripped of timestamps.
4. **Compose** — build a small HTML document: caption, then transcript under a
   heading, plus an author/date line. This is a pure function
   (`composeInstagramHtml`).
5. **Persist** — write `htmlContent`, `title`, `description`, `author`,
   `crawledAt`, `crawlStatusCode` to `bookmarkLinks` (same fields the normal
   crawl writes). Reuse `htmlContent` — **no new column, no DB migration.**
6. **Downstream** — enqueue the same post-crawl jobs the normal path does via
   the existing `enqueuePostCrawlJobs`: summarize / tag / embed / search
   reindex, **and the video-download job** (so reels' media is still fetched by
   the unchanged `videoWorker`). The UI still renders the embed; now searchable
   text sits behind it.

### Units

- **`apps/workers/workers/crawler/instagram.ts`** (new)
  - `isInstagramUrl(url: string): boolean` — host is `instagram.com` (or a
    subdomain) and the path is a `p` / `reel` / `reels` / `tv` shortcode.
  - `extractInstagramContent(url, jobId, runProxy, abortSignal): Promise<
    { caption: string; transcript: string; author: string | null;
      date: string | null } | null>` — orchestrates yt-dlp, reads the temp
    files, returns parsed fields (or `null` on failure).
  - `composeInstagramHtml(fields): string` — pure; caption + transcript →
    `htmlContent`. Unit-tested.
- **`handleInstagramBookmark(...)`** (in `instagram.ts`) — wires the above into
  a `bookmarkLinks` write, mirroring `handleAsAssetBookmark`'s structure.
  Keeping it in `instagram.ts` keeps the whole Instagram concern in one module.

### Config

- `CRAWLER_INSTAGRAM_ENABLED` (boolean, **default false**) — the feature needs
  cookies to be useful and must not change behavior for users who do not
  configure it.
- Cookies reuse the existing `CRAWLER_YTDLP_ARGS`. No new cookie mechanism.

## Error handling

- yt-dlp exits non-zero (rate limit, expired/absent cookies, private post):
  log a warning, set `crawlStatusCode` to reflect the failure, leave
  `htmlContent` empty, and **do not hard-fail the bookmark** — the embed still
  renders. We do **not** fall through to the normal browser crawl: it would only
  hit Instagram's login wall and return an empty shell, so there is nothing to
  gain.
- No auto-subs available (common on some reels): transcript is empty; still
  store the caption.
- Temp files always cleaned up (try/finally), even on failure.

## Testing

- **Unit** (`instagram.test.ts`):
  - `isInstagramUrl` — accepts `/p/`, `/reel/`, `/reels/`, `/tv/`; rejects
    profile URLs, non-Instagram hosts, and lookalike hosts.
  - `composeInstagramHtml` — caption only; caption + transcript; empty caption;
    HTML-escaping of user content.
  - VTT parsing — timestamps stripped, consecutive duplicate cues collapsed.
- **Not in CI:** the real yt-dlp fetch against Instagram requires a logged-in
  account and cannot run in CI. The yt-dlp invocation is mocked in unit tests;
  live fetching is verified manually and documented in the PR.

## Open questions / future tiers

- **Tier 2 — vision OCR** for static image posts (screenshots-as-images):
  download the image (yt-dlp already can) and run it through a vision model to
  extract on-image text. Deferred.
- **Upstream vs. personal:** this design targets an upstream karakeep PR.
  Because it reuses existing infra, the same code also works as a personal
  fork; the feature flag keeps it inert by default either way.
