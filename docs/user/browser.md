# Agent browser snapshots

When an agent inspects a page in the desktop browser preview, its snapshot
includes text and controls in the current view, page text, and scroll positions.
Controls in the current view come first. Scroll details also include visible
scroll boxes, including boxes that contain only images or canvas content.

Snapshots have a size limit. Current-view text takes priority over page text and
logs. The result reports omitted content so the agent can request more detail.
The screenshot shows the current view.

An agent can set `saveText=true` when taking a snapshot to save all loaded,
rendered main-page text to a UTF-8 file. The file has no total character cap. The
snapshot returns `textPath` in the environment so the agent can read the file
in parts. This export does not scroll or load missing content.

Complex CSS clip shapes can cause current-view text and controls to be omitted.
The result reports these omissions. Use the screenshot to inspect those areas.

On old HTML pages, a scroll box on the page body can report a size that includes
scrollbar space. Use the screenshot when precise edge positions matter.

Content that loads during scrolling is available after it loads. Embedded frames
and shadow DOM can require a separate inspection. A snapshot does not scroll the
page or change its content.
