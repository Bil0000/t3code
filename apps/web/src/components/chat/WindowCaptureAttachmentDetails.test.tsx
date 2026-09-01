import { describe, expect, it } from "vite-plus/test";

import {
  windowCaptureAccessibilityText,
  windowCaptureIncludesAccessibility,
} from "./WindowCaptureAttachmentDetails";

describe("WindowCaptureAttachmentDetails", () => {
  it("reports screenshot-only captures without inventing accessibility data", () => {
    const source = {
      kind: "window-capture" as const,
      capturedAt: "2026-08-27T00:00:00.000Z",
      appName: "Safari",
      windowTitle: "T3 Code",
    };

    expect(windowCaptureIncludesAccessibility(source)).toBe(false);
    expect(windowCaptureAccessibilityText(source)).toBeUndefined();
  });

  it("formats a structured accessibility tree when legacy text is absent", () => {
    const source = {
      kind: "window-capture" as const,
      capturedAt: "2026-08-27T00:00:00.000Z",
      appName: "Safari",
      windowTitle: "T3 Code",
      accessibility: {
        format: "element-tree" as const,
        coordinateSpace: "captured-image" as const,
        imageSize: { width: 800, height: 600 },
        truncated: false,
        root: {
          role: "window",
          name: "T3 Code",
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          children: [
            {
              role: "button",
              name: "Save",
              bounds: { x: 10, y: 10, width: 80, height: 24 },
              children: [],
            },
          ],
        },
      },
    };

    expect(windowCaptureIncludesAccessibility(source)).toBe(true);
    expect(windowCaptureAccessibilityText(source)).toBe("T3 Code\nSave");
  });
});
