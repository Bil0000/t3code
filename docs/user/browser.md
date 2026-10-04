# Agent browser snapshots

When an agent inspects a page in the desktop browser preview, its snapshot
includes text and controls in the current view, page text, and scroll positions.
Controls in the current view come first. Scroll details also include visible
scroll boxes found around text or controls.

Snapshots have a size limit. Current-view text takes priority over page text and
logs. The result reports omitted content so the agent can request more detail.
The screenshot shows the current view.

Content that loads during scrolling is available after it loads. Embedded frames
and shadow DOM can require a separate inspection. A snapshot does not scroll the
page or change its content.
