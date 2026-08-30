import { describe, expect, it } from "vite-plus/test";

import type { ComposerFileAttachment } from "../../composerDraftStore";
import { buildExpandedImagePreview } from "./ExpandedImagePreview";

describe("buildExpandedImagePreview", () => {
  it("builds a video preview for a local video attachment", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "demo.mp4", { type: "video/mp4" });
    const attachment: ComposerFileAttachment = {
      type: "file",
      id: "video-1",
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      file,
    };

    const preview = buildExpandedImagePreview([attachment], attachment.id);

    expect(preview).toMatchObject({
      images: [{ name: "demo.mp4", type: "video" }],
      index: 0,
    });
    expect(preview?.images[0]?.src).toMatch(/^blob:/);
    URL.revokeObjectURL(preview?.images[0]?.src ?? "");
  });
});
