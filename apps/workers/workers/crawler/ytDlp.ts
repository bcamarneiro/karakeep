// Helpers shared by every yt-dlp invocation in the crawler.
import { copyFile } from "node:fs/promises";
import { join } from "node:path";

import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";

/**
 * yt-dlp rewrites the cookie jar it is given when it exits, and a site's
 * response to a burst of requests can be a Set-Cookie that drops the session
 * — after which the jar on disk is logged out for good. Worse, the jar is
 * shared: a YouTube pass handed Instagram's jar writes YouTube's cookies into
 * it. Hand yt-dlp a private copy inside the pass's temp dir instead, so the
 * configured jar is only ever read. Any `--cookies <path>` in
 * CRAWLER_YTDLP_ARGS is redirected; other arguments pass through untouched.
 */
export async function privateYtDlpArgs(dir: string): Promise<string[]> {
  const args = [...serverConfig.crawler.ytDlpArguments];
  const i = args.indexOf("--cookies");
  if (i === -1 || i + 1 >= args.length) {
    return args;
  }
  const copy = join(dir, "cookies.txt");
  try {
    await copyFile(args[i + 1], copy);
    args[i + 1] = copy;
  } catch (e) {
    // A missing or unreadable jar is a configuration problem yt-dlp will
    // report on its own; don't mask it by silently running without cookies.
    logger.warn(`[Crawler] Could not copy the yt-dlp cookie jar: ${e}`);
  }
  return args;
}
