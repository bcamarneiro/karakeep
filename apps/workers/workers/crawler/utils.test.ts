import { describe, expect, it } from "vitest";

import { isRendererCrash } from "./utils";

describe("isRendererCrash", () => {
  it("recognises Playwright's renderer crash messages", () => {
    expect(isRendererCrash(new Error("page.goto: Page crashed"))).toBe(true);
    expect(isRendererCrash(new Error("Target crashed"))).toBe(true);
    expect(isRendererCrash("page.content: Target crashed")).toBe(true);
  });

  it("leaves every other navigation failure alone", () => {
    expect(
      isRendererCrash(new Error("page.goto: Timeout 60000ms exceeded")),
    ).toBe(false);
    expect(isRendererCrash(new Error("net::ERR_NAME_NOT_RESOLVED"))).toBe(
      false,
    );
    expect(
      isRendererCrash(
        new Error("Target page, context or browser has been closed"),
      ),
    ).toBe(false);
    expect(isRendererCrash(null)).toBe(false);
  });
});
