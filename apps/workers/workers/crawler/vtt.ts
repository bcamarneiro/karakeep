/**
 * Extract the spoken text out of a WebVTT file.
 *
 * Only the lines that follow a timestamp line carry payload. Everything else
 * is structure: the header block (`WEBVTT`, `Kind: captions`, `Language:`,
 * `X-TIMESTAMP-MAP=...`), `NOTE`/`STYLE`/`REGION` blocks, and the optional cue
 * identifier that may precede a timestamp (the spec allows any non-empty
 * string there, not just an index). Tracking whether we are inside a cue drops
 * all of those without having to enumerate them.
 *
 * Two details are what make YouTube's automatic captions come out readable:
 *
 * - Only a *truly* empty line ends a block. YouTube emits a single-space line
 *   as the first payload line of a cue; treating that as a terminator would
 *   drop everything said in the rest of the cue. Whitespace-only lines inside
 *   a cue are skipped instead.
 * - Inline markup is stripped. YouTube serves VTT natively, so yt-dlp's
 *   `--convert-subs vtt` is a no-op and the per-word timing markup survives
 *   (`<00:00:03.030>`, `<c>…</c>`). Removing it before the duplicate check is
 *   also what lets rolling captions — where each cue repeats the previous
 *   line with one more word — collapse instead of piling up.
 */
export function parseVtt(vtt: string): string {
  const out: string[] = [];
  let inCue = false;
  for (const raw of vtt.split(/\r?\n/)) {
    if (raw.replace(/\r$/, "") === "") {
      inCue = false; // an empty line terminates the current block
      continue;
    }
    const line = raw.trim();
    if (line.includes("-->")) {
      inCue = true; // timestamp line; its payload is on the lines below
      continue;
    }
    if (!inCue) continue; // header, comment block, or cue identifier
    const text = line.replace(/<[^>]*>/g, "").trim();
    if (!text) continue; // whitespace, or a line that was nothing but markup
    if (text === out[out.length - 1]) continue; // consecutive duplicate
    out.push(text);
  }
  return out.join(" ");
}
