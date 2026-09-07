import { describe, expect, it } from "vitest";

import { parseVtt } from "./vtt";

describe("parseVtt on YouTube automatic captions", () => {
  it("keeps a cue that opens with a blank payload line, strips inline timing markup and collapses rolling repeats", () => {
    // Shape of a real YouTube auto-caption track: a single-space first payload
    // line, per-word `<timestamp>`/`<c>` markup that survives `--convert-subs
    // vtt` because YouTube already serves VTT, and rolling cues that repeat the
    // previous line with one more word.
    const vtt = [
      "WEBVTT",
      "Kind: captions",
      "Language: en",
      "",
      "00:00:00.000 --> 00:00:03.000 align:start position:0%",
      " ",
      "so<00:00:00.500><c> today</c><00:00:00.900><c> we</c>",
      "",
      "00:00:03.000 --> 00:00:03.010 align:start position:0%",
      "so today we",
      " ",
      "",
      "00:00:03.010 --> 00:00:06.000 align:start position:0%",
      "so today we",
      "are<00:00:03.500><c> going</c><00:00:03.900><c> to</c>",
      "",
    ].join("\n");
    expect(parseVtt(vtt)).toBe("so today we are going to");
  });

  it("drops a payload line that is nothing but markup", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:02.000",
      "<c.colorE5E5E5></c>",
      "spoken words",
      "",
    ].join("\n");
    expect(parseVtt(vtt)).toBe("spoken words");
  });

  it("still ends a block on an empty line, so cue identifiers stay out", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:02.000",
      "spoken words",
      "",
      "cue-2",
      "00:00:02.000 --> 00:00:04.000",
      "more words",
      "",
    ].join("\n");
    expect(parseVtt(vtt)).toBe("spoken words more words");
  });

  it("tolerates CRLF line endings", () => {
    const vtt =
      "WEBVTT\r\n\r\n00:00:00.000 --> 00:00:02.000\r\n \r\nspoken<00:00:01.000><c> words</c>\r\n\r\n";
    expect(parseVtt(vtt)).toBe("spoken words");
  });
});
