import { describe, expect, it } from "vite-plus/test";

import { designPathFromUrl, resolveDesignPosition } from "./DesignDocument.ts";

describe("designPathFromUrl", () => {
  it("accepts the marked workspace HTML design URL", () => {
    expect(
      designPathFromUrl(
        "http://127.0.0.1:3773/api/assets/token?t3-design=request-1&t3-design-path=.t3%2Fdesigns%2Fthread-1.html",
      ),
    ).toBe(".t3/designs/thread-1.html");
  });

  it.each([
    "http://127.0.0.1:3773/api/assets/token?t3-design-path=.t3%2Fdesigns%2Fthread-1.html",
    "http://127.0.0.1:3773/api/assets/token?t3-design=request-1&t3-design-path=..%2Fsecret.html",
    "http://127.0.0.1:3773/api/assets/token?t3-design=request-1&t3-design-path=%2Ftmp%2Fdesign.html",
    "http://127.0.0.1:3773/api/assets/token?t3-design=request-1&t3-design-path=index.html",
    "http://127.0.0.1:3773/api/assets/token?t3-design=request-1&t3-design-path=.t3%2Fdesigns%2Fthread-1.svg",
  ])("rejects a URL that cannot own a workspace design", (url) => {
    expect(designPathFromUrl(url)).toBeNull();
  });
});

describe("resolveDesignPosition", () => {
  it("starts from an existing CSS translation", () => {
    expect(resolveDesignPosition(null, null, "24px -12px", 200, 100)).toEqual({
      x: 24,
      y: -12,
    });
    expect(resolveDesignPosition(null, null, "50% 25%", 200, 100)).toEqual({
      x: 100,
      y: 25,
    });
  });

  it("prefers saved editor coordinates", () => {
    expect(resolveDesignPosition("8", "16", "24px 32px", 200, 100)).toEqual({
      x: 8,
      y: 16,
    });
  });
});
