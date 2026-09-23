// Blocked-page fallback (homelab, 2026-09-23, BRU-1622).
//
// When the browser render is a bot-challenge or block page, the crawler used
// to retry and, on the last attempt, store whatever it got — a "Just a
// moment..." shell that never gets another chance. Measured on this library:
// 27 of 507 bookmarks (5%) ended that way, with Chromium + stealth.
//
// Instead of trying to look less like a bot (Cloudflare fingerprints TLS, and
// a non-Chromium browser like Lightpanda is worse at that by design), ask
// sources that already have the page:
//   1. Jina Reader (r.jina.ai) — asked for HTML so the normal readability
//      pipeline runs on it. Recovered 22 of the 27 in the measurement.
//   2. The Wayback Machine — closest snapshot, fetched with the `id_` flag so
//      the toolbar is not injected. Added 2 more.
// Each answer is checked with the same challenge detector as the render: a
// fallback that returns a block page is worse than none.
//
// Provenance is recorded in readerViewReasons (recovered_via_jina/_wayback)
// and in the log; no schema migration needed. Paywalled articles come back as their public
// teaser (Medium members-only, FT): partial content, honestly labelled.
import type { RunProxyConfig } from "network";
import { fetchWithProxy } from "network";

import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";

import { isLikelyChallengePage } from "../utils/metadataResolver";

export type BlockedFallbackSource = "jina" | "wayback";

export interface BlockedFallbackResult {
  htmlContent: string;
  via: BlockedFallbackSource;
  sourceUrl: string;
}

const MIN_USEFUL_HTML_BYTES = 1500;
const FETCH_TIMEOUT_MS = 45_000;

function titleOf(html: string): string | null {
  return /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
}

function looksUseful(html: string): boolean {
  if (html.length < MIN_USEFUL_HTML_BYTES) {
    return false;
  }
  return !isLikelyChallengePage({ title: titleOf(html), htmlContent: html });
}

function withTimeout(abortSignal: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), abortSignal]);
}

async function viaJina(
  url: string,
  jobId: string,
  runProxy: RunProxyConfig,
  abortSignal: AbortSignal,
): Promise<BlockedFallbackResult | null> {
  const base = serverConfig.crawler.jinaReaderUrl.replace(/\/+$/, "");
  const target = `${base}/${url}`;
  const headers: Record<string, string> = {
    Accept: "text/html",
    "X-Return-Format": "html",
  };
  if (serverConfig.crawler.jinaApiKey) {
    headers.Authorization = `Bearer ${serverConfig.crawler.jinaApiKey}`;
  }
  const response = await fetchWithProxy(
    target,
    { headers, signal: withTimeout(abortSignal) },
    runProxy,
  );
  if (response.status !== 200) {
    logger.info(
      `[Crawler][${jobId}] Jina Reader answered ${response.status} for the blocked page.`,
    );
    return null;
  }
  const html = await response.text();
  if (!looksUseful(html)) {
    logger.info(
      `[Crawler][${jobId}] Jina Reader returned ${html.length} bytes that do not look like an article.`,
    );
    return null;
  }
  return { htmlContent: html, via: "jina", sourceUrl: target };
}

async function viaWayback(
  url: string,
  jobId: string,
  runProxy: RunProxyConfig,
  abortSignal: AbortSignal,
): Promise<BlockedFallbackResult | null> {
  const avail = await fetchWithProxy(
    `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`,
    { signal: withTimeout(abortSignal) },
    runProxy,
  );
  if (avail.status !== 200) {
    return null;
  }
  const data = JSON.parse(await avail.text()) as {
    archived_snapshots?: {
      closest?: { available?: boolean; timestamp?: string };
    };
  };
  const closest = data.archived_snapshots?.closest;
  if (!closest?.available || !closest.timestamp) {
    logger.info(`[Crawler][${jobId}] The Wayback Machine has no snapshot.`);
    return null;
  }
  const snapshot = `https://web.archive.org/web/${closest.timestamp}id_/${url}`;
  const response = await fetchWithProxy(
    snapshot,
    { signal: withTimeout(abortSignal) },
    runProxy,
  );
  if (response.status !== 200) {
    return null;
  }
  const html = await response.text();
  if (!looksUseful(html)) {
    return null;
  }
  return { htmlContent: html, via: "wayback", sourceUrl: snapshot };
}

export async function fetchBlockedPageFallback(args: {
  url: string;
  jobId: string;
  runProxy: RunProxyConfig;
  abortSignal: AbortSignal;
}): Promise<BlockedFallbackResult | null> {
  const { url, jobId, runProxy, abortSignal } = args;
  for (const attempt of [viaJina, viaWayback]) {
    abortSignal.throwIfAborted();
    try {
      const result = await attempt(url, jobId, runProxy, abortSignal);
      if (result) {
        logger.info(
          `[Crawler][${jobId}] Blocked page recovered via ${result.via}: ${result.sourceUrl} (${result.htmlContent.length} bytes)`,
        );
        return result;
      }
    } catch (e) {
      abortSignal.throwIfAborted();
      logger.warn(
        `[Crawler][${jobId}] Blocked-page fallback ${attempt.name} failed: ${e}`,
      );
    }
  }
  return null;
}
