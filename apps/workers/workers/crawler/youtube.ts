// YouTube bookmarks, read with yt-dlp instead of the browser.
//
// A YouTube watch page is far too heavy for the crawler's Chrome, which runs
// under a deliberate memory cap: the tab crashes, the base crawl fails, and
// the bookmark ends up with no content at all. yt-dlp, by contrast, returns
// everything anonymously and cheaply — title, description, channel, upload
// date, chapters and subtitles — so when CRAWLER_YOUTUBE_TRANSCRIPT is on,
// YouTube links skip the browser entirely and are composed from yt-dlp's
// metadata. If yt-dlp returns nothing, the caller falls back to the normal
// crawl, so a broken yt-dlp degrades to the old behaviour rather than worse.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { execa } from "execa";
import type { RunProxyConfig } from "network";

import { db } from "@karakeep/db";
import { assets, AssetTypes, bookmarkLinks } from "@karakeep/db/schema";
import { ASSET_TYPES, silentDeleteAsset } from "@karakeep/shared/assetdb";
import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";

import { updateAsset } from "../../workerUtils";
import { storeHtmlContent } from "./assetStorage";
import { parseVtt } from "./vtt";
import { privateYtDlpArgs } from "./ytDlp";

export interface YouTubeChapter {
  title: string;
  startTime: number;
}

/** What yt-dlp's `.info.json` carries that is worth keeping. */
export interface YouTubeInfo {
  title: string;
  description: string;
  channel: string | null;
  /** yt-dlp's `upload_date`, kept as the raw `YYYYMMDD` it writes. */
  uploadDate: string | null;
  chapters: YouTubeChapter[];
  durationSec: number | null;
}

/**
 * What `parseInfoJson` reads, which is the content fields plus the one piece
 * of routing information: which automatic caption languages the video has.
 * That is not part of the stored content, so it is kept off `YouTubeInfo`.
 */
export interface ParsedYouTubeInfo extends YouTubeInfo {
  /** The language tags under `automatic_captions`, e.g. ["en", "pt"]. */
  autoCaptionLangs: string[];
}

export interface YouTubeContent extends YouTubeInfo {
  transcript: string;
  /** Which kind of subtitle track the text came from. */
  subs: "manual" | "auto" | "none";
  /** The language tag of the chosen track, e.g. "pt" or "en-US". */
  lang: string | null;
  /**
   * Whether the subtitle fetch actually went wrong, as opposed to the video
   * simply having no subtitles. Both leave `subs: "none"`, but only the
   * former is worth an operator's attention, so it is logged as
   * `status=partial` while a video with no captions stays `status=ok`.
   */
  failed: boolean;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A YouTube URL that identifies a single video. Channel, playlist and search
 * pages have no video metadata to read and are left to the normal crawl, so
 * they are not accepted here. Matching on the parsed hostname is what keeps
 * look-alikes such as `youtube.com.evil.com` out.
 */
export function isYouTubeUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (/(^|\.)youtube\.com$/.test(host)) {
    if (parsed.pathname === "/watch") {
      return !!parsed.searchParams.get("v");
    }
    // `/embed/videoseries?list=…` is a playlist wearing an embed URL: there
    // is no single video behind it for yt-dlp to describe.
    if (/^\/embed\/videoseries(\/|$)/.test(parsed.pathname)) {
      return false;
    }
    return /^\/(shorts|live|embed)\/[^/]+/.test(parsed.pathname);
  }
  if (/(^|\.)youtu\.be$/.test(host)) {
    return /^\/[^/]+/.test(parsed.pathname);
  }
  return false;
}

/**
 * The language tag of a subtitle file, from the `.<lang>.vtt` suffix yt-dlp
 * appends. The part before it is not matched: the output template is ours
 * (`-o <dir>/yt`), but what yt-dlp actually names the file is only confirmed
 * against the real binary, and the pass directory holds nothing else.
 */
function langOf(file: string): string | null {
  const m = /\.([A-Za-z0-9-]+)\.vtt$/.exec(file);
  return m ? m[1] : null;
}

/**
 * Order the subtitle files by the configured language preference.
 * `CRAWLER_YOUTUBE_SUB_LANGS` holds yt-dlp language selectors ("pt.*,en.*"),
 * so a trailing `.*` is a prefix match: "pt.*" matches the `pt`, `pt-BR` and
 * `pt-orig` tracks YouTube serves. Anything else is matched literally.
 *
 * Every track is returned, not just the best one: a preferred track can turn
 * out to parse to nothing (YouTube serves position-only or empty cues for
 * some videos), and it must not shadow a lower-preference track that does
 * carry text. Tracks matching no selector sort last — they still beat no
 * transcript at all.
 */
function langSpecs(langs: string): string[] {
  return langs
    .split(",")
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The index of the first selector a language tag matches, or -1 for none.
 * A trailing `.*` is a prefix match ("pt.*" covers `pt`, `pt-BR`, `pt-orig`);
 * anything else is matched literally.
 */
function langRank(lang: string, specs: string[]): number {
  const l = lang.toLowerCase();
  return specs.findIndex((spec) =>
    spec.endsWith(".*") ? l.startsWith(spec.slice(0, -2)) : l === spec,
  );
}

/** Whether any of these language tags is one the configuration asked for. */
export function hasPreferredLang(tags: string[], langs: string): boolean {
  const specs = langSpecs(langs);
  return tags.some((t) => langRank(t, specs) !== -1);
}

export function orderSubtitleFiles(
  files: string[],
  langs: string,
): { file: string; lang: string }[] {
  const specs = langSpecs(langs);
  const rank = ({ lang }: { lang: string }) => {
    const i = langRank(lang, specs);
    return i === -1 ? specs.length : i;
  };
  return (
    files
      .map((file) => ({ file, lang: langOf(file) }))
      .filter((c): c is { file: string; lang: string } => c.lang !== null)
      // Sort by lang tag first so ties within one selector are deterministic.
      .sort((a, b) => a.lang.localeCompare(b.lang))
      .sort((a, b) => rank(a) - rank(b))
  );
}

/**
 * Read the fields worth keeping out of yt-dlp's `.info.json`. Every one of
 * them is optional there — a livestream has no upload date, most videos have
 * no chapters — so each is defaulted rather than assumed.
 */
export function parseInfoJson(raw: string): ParsedYouTubeInfo | null {
  interface RawInfo {
    title?: string;
    description?: string;
    uploader?: string;
    channel?: string;
    upload_date?: string;
    duration?: number;
    chapters?: { title?: string; start_time?: number }[] | null;
    automatic_captions?: Record<string, unknown> | null;
  }
  let info: RawInfo;
  try {
    info = JSON.parse(raw) as RawInfo;
  } catch {
    return null;
  }
  const chapters: YouTubeChapter[] = [];
  for (const c of info.chapters ?? []) {
    if (typeof c?.start_time === "number") {
      chapters.push({ title: c.title ?? "", startTime: c.start_time });
    }
  }
  return {
    title: info.title ?? "",
    description: info.description ?? "",
    channel: info.uploader ?? info.channel ?? null,
    uploadDate: info.upload_date ?? null,
    chapters,
    durationSec: typeof info.duration === "number" ? info.duration : null,
    autoCaptionLangs: Object.keys(info.automatic_captions ?? {}),
  };
}

interface PassResult {
  track: { transcript: string; lang: string } | null;
  info: ParsedYouTubeInfo | null;
  /** yt-dlp itself misbehaved, as opposed to the video having no such track. */
  failed: boolean;
}

/**
 * One yt-dlp pass, into a directory of its own so that `readdir` only ever
 * sees this pass's files — a leftover from the manual pass would otherwise be
 * picked up by, and mislabelled as, the automatic one.
 */
async function ytDlpPass(
  url: string,
  jobId: string,
  opts: { auto: boolean; info: boolean },
  runProxy: RunProxyConfig,
  abortSignal: AbortSignal,
): Promise<PassResult> {
  const dir = await mkdtemp(join(tmpdir(), "karakeep-yt-"));
  try {
    return await runYtDlpPass(url, dir, jobId, opts, runProxy, abortSignal);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** yt-dlp said the video simply has no track of the kind asked for. */
const NO_SUBTITLES =
  /there are no subtitles|has no subtitles|no subtitles for the requested|no automatic captions|no auto.?generated/i;

/** yt-dlp itself misbehaved: throttled, refused, or could not reach YouTube. */
const REAL_FAILURE =
  /HTTP Error 429|HTTP Error 5\d\d|rate.?limit|Unable to download|ERROR:/i;

/**
 * Whether a non-zero yt-dlp exit was a real failure or just a video without
 * the requested captions — the exit code alone cannot tell them apart, so the
 * classification is made on stderr, line by line so that a "no subtitles"
 * notice on one line does not excuse an `ERROR:` on another.
 *
 * An exit with no stderr at all counts as a failure: with aborts propagating
 * separately, what is left are ENOENT (no yt-dlp on PATH) and the execa
 * timeout, both of which an operator wants to see as subs_status=partial.
 */
export function isRealYtDlpFailure(stderr: string | undefined): boolean {
  if (!stderr?.trim()) {
    return true;
  }
  return stderr
    .split("\n")
    .some((line) => REAL_FAILURE.test(line) && !NO_SUBTITLES.test(line));
}

/**
 * yt-dlp exits non-zero both when a video carries no track of the kind asked
 * for and when it actually failed, so the exit is classified on stderr and
 * whatever landed on disk is read anyway — a throw here must not cost us the
 * metadata yt-dlp wrote before it, nor the other pass.
 */
async function runYtDlpPass(
  url: string,
  dir: string,
  jobId: string,
  opts: { auto: boolean; info: boolean },
  runProxy: RunProxyConfig,
  abortSignal: AbortSignal,
): Promise<PassResult> {
  const proxy = runProxy.httpsProxy ?? runProxy.httpProxy;
  const args = [
    "--skip-download",
    ...(opts.info ? ["--write-info-json"] : []),
    opts.auto ? "--write-auto-subs" : "--write-subs",
    "--sub-langs",
    serverConfig.crawler.youtubeSubLangs,
    "--convert-subs",
    "vtt",
    "--no-playlist",
    "-o",
    join(dir, "yt"),
    // Never the configured jar itself: yt-dlp rewrites what it is given.
    ...(await privateYtDlpArgs(dir)),
    ...(proxy ? ["--proxy", proxy] : []),
    "--",
    url,
  ];
  let failed = false;
  try {
    await execa("yt-dlp", args, {
      cancelSignal: abortSignal,
      // Half the job's budget, so a stuck pass still leaves the job time to
      // run the other one and store what it got.
      timeout: Math.floor(
        Math.min(60_000, (serverConfig.crawler.jobTimeoutSec * 1000) / 2),
      ),
    });
  } catch (e) {
    // A video with no track of the kind asked for also exits non-zero, so
    // the exit code is not conclusive: stderr is what separates "this video
    // has no captions" from "yt-dlp was throttled".
    failed = isRealYtDlpFailure((e as { stderr?: string }).stderr);
    logger.warn(
      `[Crawler][${jobId}] yt-dlp ${
        opts.auto ? "auto" : "manual"
      } pass exited non-zero for "${url}"${
        failed ? "" : " (no subtitles of that kind)"
      }: ${e}`,
    );
  }

  const files = await readdir(dir);

  let info: ParsedYouTubeInfo | null = null;
  if (opts.info) {
    const infoName = files.find((f) => f.endsWith(".info.json"));
    if (infoName) {
      info = parseInfoJson(await readFile(join(dir, infoName), "utf8"));
    }
  }

  for (const { file, lang } of orderSubtitleFiles(
    files.filter((f) => f.endsWith(".vtt")),
    serverConfig.crawler.youtubeSubLangs,
  )) {
    const transcript = parseVtt(await readFile(join(dir, file), "utf8"));
    if (transcript) {
      return { track: { transcript, lang }, info, failed: false };
    }
  }
  return { track: null, info, failed };
}

/**
 * Read everything yt-dlp can tell us about a video.
 *
 * The metadata and the human-written subtitles come from one invocation. A
 * second is needed only for automatic captions, because yt-dlp names manual
 * and automatic subtitles identically (`yt.<lang>.vtt`): asking for both at
 * once leaves no way to tell which kind landed, while two passes settle it
 * without guessing about file names, and cost a second request only for the
 * videos that have no human captions.
 *
 * Returns null only when there is no `.info.json` at all — yt-dlp failed
 * outright — so that the caller can fall back to the normal browser crawl.
 * The one thing it does throw on is an abort: a cancelled job must not be
 * finished off with whatever half of the passes managed to produce.
 */
export async function extractYouTubeContent(
  url: string,
  jobId: string,
  runProxy: RunProxyConfig,
  abortSignal: AbortSignal,
): Promise<YouTubeContent | null> {
  try {
    const first = await ytDlpPass(
      url,
      jobId,
      { auto: false, info: true },
      runProxy,
      abortSignal,
    );
    if (!first.info) {
      logger.warn(
        `[Crawler][${jobId}] yt-dlp returned no metadata for "${url}"`,
      );
      return null;
    }

    let track = first.track;
    let subs: YouTubeContent["subs"] = track ? "manual" : "none";
    let failed = track ? false : first.failed;

    // The info.json lists which automatic caption languages exist. If none of
    // them is one we asked for, the second pass can only come back empty, so
    // it is not worth a second request to YouTube.
    const autoWorthTrying = hasPreferredLang(
      first.info.autoCaptionLangs,
      serverConfig.crawler.youtubeSubLangs,
    );

    if (!track && autoWorthTrying && !abortSignal.aborted) {
      const second = await ytDlpPass(
        url,
        jobId,
        { auto: true, info: false },
        runProxy,
        abortSignal,
      );
      if (second.track) {
        track = second.track;
        subs = "auto";
        failed = false;
      } else {
        failed = failed || second.failed;
      }
    }

    const { autoCaptionLangs: _autoCaptionLangs, ...info } = first.info;
    const content: YouTubeContent = {
      ...info,
      transcript: track?.transcript ?? "",
      subs,
      lang: track?.lang ?? null,
      failed,
    };
    // An abort during a pass is swallowed into `failed` above, which would
    // otherwise store a partial result for a job that was told to stop.
    abortSignal.throwIfAborted();
    return content;
  } catch (e) {
    if (abortSignal.aborted) {
      throw e;
    }
    logger.warn(
      `[Crawler][${jobId}] YouTube extraction failed for "${url}": ${e}`,
    );
    return null;
  }
}

/** `mm:ss`, or `h:mm:ss` once a chapter starts past the first hour. */
export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  const hh = Math.floor(s / 3600);
  const mm = Math.floor(s / 60) % 60;
  const ss = s % 60;
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

/**
 * A description is plain text with newlines. Keep its shape: blank lines
 * separate paragraphs and single newlines become `<br>`, so the links and
 * timestamps creators list one per line stay readable instead of collapsing
 * into a wall of text.
 */
function descriptionHtml(description: string): string {
  return description
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map(
      (para) =>
        `<p>${para
          .split("\n")
          .map((line) => escapeHtml(line.trim()))
          .join("<br>")}</p>`,
    )
    .join("\n");
}

export function youtubeMarker(content: YouTubeContent): string {
  return `<!-- karakeep-yt subs=${content.subs} lang=${
    content.lang ?? "none"
  } status=${content.failed ? "partial" : "ok"} -->`;
}

export function composeYouTubeHtml(content: YouTubeContent): string {
  const parts: string[] = [];
  if (content.title) {
    parts.push(`<h1>${escapeHtml(content.title)}</h1>`);
  }
  const description = descriptionHtml(content.description);
  if (description) {
    parts.push(description);
  }
  if (content.chapters.length > 0) {
    parts.push(`<h2>Chapters</h2>`);
    parts.push(
      `<ul>\n${content.chapters
        .map(
          (c) =>
            `<li>${formatTimestamp(c.startTime)} – ${escapeHtml(c.title)}</li>`,
        )
        .join("\n")}\n</ul>`,
    );
  }
  if (content.transcript) {
    parts.push(`<h2>Transcript</h2>`);
    parts.push(`<p>${escapeHtml(content.transcript)}</p>`);
  }
  const date = content.uploadDate
    ? content.uploadDate.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")
    : null;
  const footer = [content.channel, date].filter(Boolean).join(" · ");
  if (footer) {
    parts.push(`<p><small>${escapeHtml(footer)}</small></p>`);
  }
  parts.push(youtubeMarker(content));
  return parts.join("\n");
}

/**
 * Persist the composed HTML the way the crawler persists page content:
 * inline in `bookmarkLinks.htmlContent` below
 * HTML_CONTENT_SIZE_INLINE_THRESHOLD, in an asset above it. A content asset
 * left by an earlier crawl is superseded and deleted.
 *
 * `columns` goes into the same transaction, so the bookmark never shows new
 * metadata against old content. When the store is refused (quota), the
 * metadata is still written but the content is left exactly as it was:
 * writing the "nothing stored" shape would delete an earlier crawl's content.
 */
async function storeYouTubeHtml(args: {
  bookmarkId: string;
  userId: string;
  jobId: string;
  html: string;
  columns: Record<string, unknown>;
}): Promise<boolean> {
  const { bookmarkId, userId, jobId, html, columns } = args;

  const link = await db.query.bookmarkLinks.findFirst({
    where: eq(bookmarkLinks.id, bookmarkId),
    columns: { contentAssetId: true },
  });
  if (!link) {
    logger.warn(
      `[Crawler][${jobId}] Bookmark ${bookmarkId} is gone; not storing YouTube content`,
    );
    return false;
  }

  const stored = await storeHtmlContent(html, userId, jobId);
  if (stored.result === "not_stored") {
    logger.warn(
      `[Crawler][${jobId}] Could not store YouTube content for bookmark ${bookmarkId}; keeping the metadata only`,
    );
    await db
      .update(bookmarkLinks)
      .set(columns)
      .where(eq(bookmarkLinks.id, bookmarkId));
    return false;
  }

  await db.transaction(async (txn) => {
    await txn
      .update(bookmarkLinks)
      .set({
        ...columns,
        htmlContent: stored.result === "store_inline" ? html : null,
        contentAssetId: stored.result === "stored" ? stored.assetId : null,
      })
      .where(eq(bookmarkLinks.id, bookmarkId));

    if (stored.result === "stored") {
      await updateAsset(
        link.contentAssetId ?? undefined,
        {
          id: stored.assetId,
          bookmarkId,
          userId,
          assetType: AssetTypes.LINK_HTML_CONTENT,
          contentType: ASSET_TYPES.TEXT_HTML,
          size: stored.size,
          fileName: null,
        },
        txn,
      );
    } else if (link.contentAssetId) {
      // The content fits inline now; unlink the asset row.
      await txn.delete(assets).where(eq(assets.id, link.contentAssetId));
    }
  });
  await silentDeleteAsset(userId, link.contentAssetId ?? undefined);
  return true;
}

/**
 * Read a YouTube bookmark with yt-dlp and store it, in place of the browser
 * crawl. Returns whether the bookmark was handled; false means the caller
 * should fall back to the normal crawl.
 */
export async function handleYouTubeBookmark(args: {
  url: string;
  jobId: string;
  bookmarkId: string;
  userId: string;
  runProxy: RunProxyConfig;
  abortSignal: AbortSignal;
}): Promise<boolean> {
  const { url, jobId, bookmarkId, userId, runProxy, abortSignal } = args;
  const content = await extractYouTubeContent(
    url,
    jobId,
    runProxy,
    abortSignal,
  );
  if (!content) {
    return false;
  }

  // A video may have an empty description, and a live recording an empty
  // title. Only set the columns we have a value for: passing null would
  // overwrite something an earlier crawl or the user put there.
  const summary = content.description || content.transcript;
  const stored = await storeYouTubeHtml({
    bookmarkId,
    userId,
    jobId,
    html: composeYouTubeHtml(content),
    columns: {
      ...(content.title ? { title: content.title.slice(0, 100) } : {}),
      ...(summary ? { description: summary.slice(0, 300) } : {}),
      ...(content.channel ? { author: content.channel } : {}),
      crawledAt: new Date(),
      crawlStatusCode: 200,
    },
  });

  logger.info(
    `[Crawler][${jobId}] [yt] path=ytdlp subs=${content.subs} lang=${
      content.lang ?? "none"
    } chapters=${content.chapters.length} status=${
      content.failed || !stored ? "partial" : "ok"
    } url="${url}"`,
  );
  return true;
}
