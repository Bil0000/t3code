import { describe, expect, it } from "vite-plus/test";

import { designPathFromUrl } from "./DesignDocument.ts";

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
