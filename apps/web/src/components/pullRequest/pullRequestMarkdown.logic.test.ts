import { describe, expect, it } from "vite-plus/test";

import { splitPullRequestBody } from "./pullRequestMarkdown.logic";

describe("pull request body segmentation", () => {
  it("keeps a plain body as a single markdown run", () => {
    expect(splitPullRequestBody("## What changed\n\nSome prose.")).toEqual([
      { id: "markdown:0", kind: "markdown", text: "## What changed\n\nSome prose." },
    ]);
  });

  it("plays a dropped attachment link and keeps the prose around it", () => {
    expect(
      splitPullRequestBody(
        "Before\n\nhttps://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-abcdef123456\n\nAfter",
      ),
    ).toEqual([
      { id: "markdown:0", kind: "markdown", text: "Before" },
      {
        id: "video:1",
        kind: "video",
        url: "https://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-abcdef123456",
      },
      { id: "markdown:2", kind: "markdown", text: "After" },
    ]);
  });

  it("plays a bare link to a video file", () => {
    expect(splitPullRequestBody("https://example.com/demo.mp4?raw=1")).toEqual([
      { id: "video:0", kind: "video", url: "https://example.com/demo.mp4?raw=1" },
    ]);
  });

  it("reads the source out of a video tag, including a multi-line one", () => {
    expect(
      splitPullRequestBody(
        '<video controls>\n  <source src="https://example.com/a.webm">\n</video>',
      ),
    ).toEqual([{ id: "video:0", kind: "video", url: "https://example.com/a.webm" }]);
  });

  it("leaves a dropped image as markdown so it still renders as an image", () => {
    const body = "![shot](https://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-ab)";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("never turns a link inside fenced code into a player", () => {
    const body = "```\nhttps://example.com/demo.mp4\n```";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("refuses a non-http source rather than putting it in a player", () => {
    const body = '<video src="javascript:alert(1)"></video>';
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });
});
