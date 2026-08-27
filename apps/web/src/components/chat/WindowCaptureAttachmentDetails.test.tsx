import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { WindowCaptureAttachmentDetails } from "./WindowCaptureAttachmentDetails";

describe("WindowCaptureAttachmentDetails", () => {
  it("keeps fallback icon text in source case while displaying it uppercase", () => {
    const markup = renderToStaticMarkup(
      <WindowCaptureAttachmentDetails
        source={{
          kind: "window-capture",
          capturedAt: "2026-08-27T00:00:00.000Z",
          appName: "safari",
          windowTitle: "T3 Code",
        }}
      />,
    );

    expect(markup).toContain("uppercase");
    expect(markup).toContain(">s</div>");
  });
});
