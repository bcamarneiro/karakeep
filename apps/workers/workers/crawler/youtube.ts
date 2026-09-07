// YouTube transcripts. A normal browser crawl of a YouTube page yields the
// chrome around the player and none of what is said in the video, so a video
// bookmark carries almost nothing for search, tagging or summarization to
// work with. When CRAWLER_YOUTUBE_TRANSCRIPT is on, this module asks yt-dlp
// for the subtitle track after the page has been crawled and appends it to
// the stored content, before the post-crawl jobs run.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { execa } from "execa";
import type { RunProxyConfig } from "network";

import { db } from "@karakeep/db";
import { assets, AssetTypes, bookmarkLinks } from "@karakeep/db/schema";
import {
  ASSET_TYPES,
  readAsset,
  silentDeleteAsset,
} from "@karakeep/shared/assetdb";
import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";

import { updateAsset } from "../../workerUtils";
import { storeHtmlContent } from "./assetStorage";
import { parseVtt } from "./vtt";

export interface YouTubeTranscript {
  transcript: string;
  /** Which kind of subtitle track the text came from. */
  source: "manual" | "auto" | "none";
  /** The language tag of the chosen track, e.g. "pt" or "en-US". */
  lang: string | null;
}

const NO_TRANSCRIPT: YouTubeTranscript = {
  transcript: "",
  source: "none",
  lang: null,
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A YouTube URL that identifies a single video. Channel, playlist and search
 * pages crawl fine as pages and have no transcript to fetch, so they are not
 * accepted here. Matching on the parsed hostname is what keeps look-alikes
 * such as `youtube.com.evil.com` out.
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
    return /^\/(shorts|live|embed)\/[^/]+/.test(parsed.pathname);
  }
  if (/(^|\.)youtu\.be$/.test(host)) {
    return /^\/[^/]+/.test(parsed.pathname);
  }
  return false;
}

/**
 * The language tag out of a subtitle file yt-dlp wrote as `<base>.<lang>.vtt`.
 */
function langOf(file: string, base: string): string | null {
  const m = new RegExp(`^${base}\\.(.+)\\.vtt$`).exec(file);
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
export function orderSubtitleFiles(
  files: string[],
  langs: string,
  base = "yt",
): { file: string; lang: string }[] {
  const specs = langs
    .split(",")
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
  const rank = ({ lang }: { lang: string }) => {
    const l = lang.toLowerCase();
    const i = specs.findIndex((spec) =>
      spec.endsWith(".*") ? l.startsWith(spec.slice(0, -2)) : l === spec,
    );
    return i === -1 ? specs.length : i;
  };
  return (
    files
      .map((file) => ({ file, lang: langOf(file, base) }))
      .filter((c): c is { file: string; lang: string } => c.lang !== null)
      // Sort by lang tag first so ties within one selector are deterministic.
      .sort((a, b) => a.lang.localeCompare(b.lang))
      .sort((a, b) => rank(a) - rank(b))
  );
}

/**
 * One yt-dlp subtitle pass, into a directory of its own so that `readdir`
 * only ever sees this pass's files — a leftover from the manual pass would
 * otherwise be picked up by, and mislabelled as, the automatic one.
 *
 * Returns the transcript of the first track, in configured language order,
 * that parses to something. yt-dlp exits non-zero when a video carries no
 * track of the kind asked for, so, as on the Instagram path, the exit code is
 * logged and whatever landed on disk is read anyway — a throw here must not
 * cost us the other pass.
 */
async function subtitlePass(
  url: string,
  jobId: string,
  auto: boolean,
  runProxy: RunProxyConfig,
  abortSignal: AbortSignal,
): Promise<{ transcript: string; lang: string } | null> {
  const dir = await mkdtemp(join(tmpdir(), "karakeep-yt-"));
  try {
    return await runSubtitlePass(url, dir, jobId, auto, runProxy, abortSignal);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runSubtitlePass(
  url: string,
  dir: string,
  jobId: string,
  auto: boolean,
  runProxy: RunProxyConfig,
  abortSignal: AbortSignal,
): Promise<{ transcript: string; lang: string } | null> {
  const proxy = runProxy.httpsProxy ?? runProxy.httpProxy;
  const args = [
    "--skip-download",
    auto ? "--write-auto-subs" : "--write-subs",
    "--sub-langs",
    serverConfig.crawler.youtubeSubLangs,
    "--convert-subs",
    "vtt",
    "--no-playlist",
    "-o",
    join(dir, "yt"),
    ...serverConfig.crawler.ytDlpArguments,
    ...(proxy ? ["--proxy", proxy] : []),
    "--",
    url,
  ];
  try {
    await execa("yt-dlp", args, {
      cancelSignal: abortSignal,
      timeout: 60_000,
    });
  } catch (e) {
    logger.warn(
      `[Crawler][${jobId}] yt-dlp ${
        auto ? "auto" : "manual"
      } subtitle pass exited non-zero for "${url}": ${e}`,
    );
  }
  const files = (await readdir(dir)).filter((f) => f.endsWith(".vtt"));
  for (const { file, lang } of orderSubtitleFiles(
    files,
    serverConfig.crawler.youtubeSubLangs,
  )) {
    const transcript = parseVtt(await readFile(join(dir, file), "utf8"));
    if (transcript) {
      return { transcript, lang };
    }
  }
  return null;
}

/**
 * Fetch the best available subtitle track for a YouTube video.
 *
 * yt-dlp names manual and automatic subtitles identically (`yt.<lang>.vtt`),
 * so asking for both in one run leaves no way to tell which kind landed.
 * Two passes settle it instead: ask for manual subtitles only, and run the
 * automatic pass just for the videos that have none. That costs a second
 * request only for videos without human-written captions, and needs no
 * guessing about file names.
 *
 * Never throws: a video without subtitles, an unavailable video and a broken
 * yt-dlp all report `none`, because a missing transcript must not fail the
 * crawl that already succeeded.
 */
export async function fetchYouTubeTranscript(
  url: string,
  jobId: string,
  runProxy: RunProxyConfig,
  abortSignal: AbortSignal,
): Promise<YouTubeTranscript> {
  try {
    for (const auto of [false, true]) {
      const found = await subtitlePass(url, jobId, auto, runProxy, abortSignal);
      if (found) {
        return {
          transcript: found.transcript,
          source: auto ? "auto" : "manual",
          lang: found.lang,
        };
      }
      if (abortSignal.aborted) break;
    }
    return NO_TRANSCRIPT;
  } catch (e) {
    logger.warn(
      `[Crawler][${jobId}] YouTube transcript fetch failed for "${url}": ${e}`,
    );
    return NO_TRANSCRIPT;
  }
}

/**
 * The crawled content with the transcript appended, in the same shape the
 * Instagram path uses so both read the same in the reader view.
 */
export function appendTranscriptHtml(
  existing: string | null,
  transcript: string,
): string {
  const section = `<h2>Transcript</h2>\n<p>${escapeHtml(transcript)}</p>`;
  return existing ? `${existing}\n${section}` : section;
}

/**
 * Append the transcript to the content the crawler just stored, honouring the
 * same inline-vs-asset split: content below HTML_CONTENT_SIZE_INLINE_THRESHOLD
 * lives in bookmarkLinks.htmlContent, larger content in an asset. Since the
 * transcript can push a bookmark over the threshold, the combined content
 * goes back through storeHtmlContent and lands wherever that says.
 *
 * Returns whether anything was written.
 */
export async function appendYouTubeTranscript(args: {
  bookmarkId: string;
  userId: string;
  jobId: string;
  transcript: string;
}): Promise<boolean> {
  const { bookmarkId, userId, jobId, transcript } = args;

  // Read the content ids back rather than trusting what the job started with:
  // the crawl that just ran has already replaced them.
  const link = await db.query.bookmarkLinks.findFirst({
    where: eq(bookmarkLinks.id, bookmarkId),
    columns: { htmlContent: true, contentAssetId: true },
  });
  if (!link) {
    logger.warn(
      `[Crawler][${jobId}] Bookmark ${bookmarkId} is gone; not appending a transcript`,
    );
    return false;
  }

  let existing = link.htmlContent;
  if (link.contentAssetId) {
    const asset = await readAsset({ userId, assetId: link.contentAssetId });
    existing = asset.asset.toString("utf8");
  }

  const combined = appendTranscriptHtml(existing, transcript);
  const stored = await storeHtmlContent(combined, userId, jobId);
  if (stored.result === "not_stored") {
    // Quota refused the write. Leave the crawled content alone: writing the
    // "nothing stored" shape here would delete what the crawl just saved.
    logger.warn(
      `[Crawler][${jobId}] Could not store the transcript for bookmark ${bookmarkId}; leaving the crawled content as-is`,
    );
    return false;
  }

  await db.transaction(async (txn) => {
    await txn
      .update(bookmarkLinks)
      .set({
        htmlContent: stored.result === "store_inline" ? combined : null,
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
      // The combined content fits inline now; unlink the asset row.
      await txn.delete(assets).where(eq(assets.id, link.contentAssetId));
    }
  });
  await silentDeleteAsset(userId, link.contentAssetId ?? undefined);
  return true;
}
