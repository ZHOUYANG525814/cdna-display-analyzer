import { describe, expect, it } from "vitest";
import { isMobileOrTablet } from "../src/lib/deviceSupport";

const desktop = { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/142.0", platform: "Linux x86_64", maxTouchPoints: 0 };

describe("desktop device gate", () => {
  it("allows desktop browsers regardless of viewport size", () => {
    expect(isMobileOrTablet(desktop)).toBe(false);
    expect(isMobileOrTablet({ ...desktop, userAgentDataMobile: false })).toBe(false);
  });

  it.each([
    { ...desktop, userAgentDataMobile: true },
    { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile", platform: "iPhone", maxTouchPoints: 5 },
    { userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel Tablet)", platform: "Linux armv8l", maxTouchPoints: 10 },
    { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", platform: "MacIntel", maxTouchPoints: 5 },
  ])("blocks mobile/tablet signal set %#", (signals) => {
    expect(isMobileOrTablet(signals)).toBe(true);
  });
});
