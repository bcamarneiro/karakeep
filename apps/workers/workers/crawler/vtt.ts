/**
 * Extract the spoken text out of a WebVTT file.
 *
 * Only the lines that follow a timestamp line carry payload. Everything else
 * is structure: the header block (`WEBVTT`, `Kind: captions`, `Language:`,
 * `X-TIMESTAMP-MAP=...`), `NOTE`/`STYLE`/`REGION` blocks, and the optional cue
 * identifier that may precede a timestamp (the spec allows any non-empty
 * string there, not just an index). Tracking whether we are inside a cue drops
 * all of those without having to enumerate them.
 */
export function parseVtt(vtt: string): string {
  const out: string[] = [];
  let inCue = false;
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      inCue = false; // a blank line terminates the current block
      continue;
    }
    if (line.includes("-->")) {
      inCue = true; // timestamp line; its payload is on the lines below
      continue;
    }
    if (!inCue) continue; // header, comment block, or cue identifier
    if (line === out[out.length - 1]) continue; // consecutive duplicate
    out.push(line);
  }
  return out.join(" ");
}
