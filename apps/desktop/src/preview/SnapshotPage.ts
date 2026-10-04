import type { PreviewAutomationSnapshot } from "@t3tools/contracts";

export type SnapshotPage = Pick<
  PreviewAutomationSnapshot,
  | "url"
  | "title"
  | "loading"
  | "visibleText"
  | "viewportText"
  | "scroll"
  | "truncated"
  | "interactiveElements"
>;

function collectSnapshotPage(): SnapshotPage {
  const maxTextLength = 20_000;
  const maxElements = 200;
  const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  type Bounds = typeof viewport;
  const intersects = (rect: Bounds, clip: Bounds) =>
    rect.right > clip.left &&
    rect.left < clip.right &&
    rect.bottom > clip.top &&
    rect.top < clip.bottom;
  const selectorFor = (element: Element): string => {
    if (element.id) return "#" + CSS.escape(element.id);
    for (const attribute of ["data-testid", "name"]) {
      const value = element.getAttribute(attribute);
      if (value)
        return element.tagName.toLowerCase() + "[" + attribute + "=" + CSS.escape(value) + "]";
    }
    const parts: string[] = [];
    for (
      let current: Element | null = element;
      current && parts.length < 8;
      current = current.parentElement
    ) {
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter(
            (child) => child.tagName === current.tagName,
          )
        : [];
      parts.unshift(
        current.tagName.toLowerCase() +
          (siblings.length > 1 ? ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")" : ""),
      );
    }
    return parts.join(" > ");
  };
  const containers: Array<NonNullable<SnapshotPage["scroll"]>["containers"][number]> = [];
  let containersTruncated = false;
  const clips = new Map<Element, Bounds | null>();
  const styles = new Map<Element, CSSStyleDeclaration>();
  const styleFor = (element: Element) => {
    let style = styles.get(element);
    if (!style) {
      style = getComputedStyle(element);
      styles.set(element, style);
    }
    return style;
  };
  const clipFor = (element: Element): Bounds | null => {
    const pending: Element[] = [];
    let ancestor: Element | null = element;
    while (ancestor && !clips.has(ancestor)) {
      pending.push(ancestor);
      ancestor =
        ancestor instanceof HTMLElement && /^(absolute|fixed)$/.test(styleFor(ancestor).position)
          ? ancestor.offsetParent
          : ancestor.parentElement;
    }
    let parentClip: Bounds | null = ancestor ? (clips.get(ancestor) ?? null) : viewport;
    for (let index = pending.length - 1; index >= 0; index--) {
      const current = pending[index]!;
      const style = styleFor(current);
      if (
        !parentClip ||
        style.display === "none" ||
        style.opacity === "0" ||
        style.contentVisibility === "hidden"
      ) {
        clips.set(current, null);
        parentClip = null;
        continue;
      }
      const clip = { ...parentClip };
      const rootStyle = styleFor(document.documentElement);
      const viewportBody =
        current === document.body &&
        rootStyle.overflowX === "visible" &&
        rootStyle.overflowY === "visible";
      if (current !== document.documentElement && !viewportBody && style.display !== "contents") {
        const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
        const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
        if (clipsX || clipsY) {
          const rect = current.getBoundingClientRect();
          const quirksBody =
            current === document.body &&
            current instanceof HTMLElement &&
            document.compatMode === "BackCompat";
          const clientWidth = quirksBody
            ? Math.max(
                0,
                current.offsetWidth -
                  current.clientLeft -
                  Number.parseFloat(style.borderRightWidth),
              )
            : current.clientWidth;
          const clientHeight = quirksBody
            ? Math.max(
                0,
                current.offsetHeight -
                  current.clientTop -
                  Number.parseFloat(style.borderBottomWidth),
              )
            : current.clientHeight;
          const scaleX =
            current instanceof HTMLElement && current.offsetWidth
              ? rect.width / current.offsetWidth
              : 1;
          const scaleY =
            current instanceof HTMLElement && current.offsetHeight
              ? rect.height / current.offsetHeight
              : 1;
          if (clipsX) {
            clip.left = Math.max(clip.left, rect.left + current.clientLeft * scaleX);
            clip.right = Math.min(
              clip.right,
              rect.left + (current.clientLeft + clientWidth) * scaleX,
            );
          }
          if (clipsY) {
            clip.top = Math.max(clip.top, rect.top + current.clientTop * scaleY);
            clip.bottom = Math.min(
              clip.bottom,
              rect.top + (current.clientTop + clientHeight) * scaleY,
            );
          }
          const scrollable =
            (/^(auto|scroll)$/.test(style.overflowX) && current.scrollWidth > clientWidth) ||
            (/^(auto|scroll)$/.test(style.overflowY) && current.scrollHeight > clientHeight);
          if (scrollable && intersects(rect, parentClip)) {
            const selector = containers.length < 20 ? selectorFor(current) : null;
            if (selector !== null && selector.length <= 1_000) {
              containers.push({
                selector,
                x: current.scrollLeft,
                y: current.scrollTop,
                width: clientWidth,
                height: clientHeight,
                scrollWidth: current.scrollWidth,
                scrollHeight: current.scrollHeight,
              });
            } else containersTruncated = true;
          }
        }
      }
      parentClip = clip.right > clip.left && clip.bottom > clip.top ? clip : null;
      clips.set(current, parentClip);
    }
    return clips.get(element)!;
  };
  const rendered = (element: Element) => {
    const style = styleFor(element);
    let box = element;
    while (styleFor(box).display === "contents" && box.parentElement) box = box.parentElement;
    return (
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      style.display !== "none" &&
      box.checkVisibility({
        checkOpacity: true,
        contentVisibilityAuto: true,
      })
    );
  };
  const inViewport = (element: Element, rect: DOMRect) => {
    if (!intersects(rect, viewport)) return false;
    const clip = clipFor(element);
    return clip !== null && intersects(rect, clip);
  };
  const currentElements: Element[] = [];
  const otherElements: Element[] = [];
  let elementCount = 0;
  for (const element of document.querySelectorAll(
    "a[href],button,input,textarea,select,[role],[tabindex]",
  )) {
    if (!rendered(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const current = inViewport(element, rect);
    elementCount++;
    const target = current ? currentElements : otherElements;
    if (target.length < maxElements) target.push(element);
  }
  const interactiveElements = [...currentElements, ...otherElements]
    .slice(0, maxElements)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        name: (
          element.getAttribute("aria-label") ||
          (element instanceof HTMLElement ? element.innerText : "") ||
          element.getAttribute("name") ||
          ""
        ).slice(0, 200),
        selector: selectorFor(element),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        inViewport: currentElements.includes(element),
      };
    });
  let viewportText = "";
  let viewportTextTruncated = false;
  let rangeReads = 0;
  let nodeText = "";
  const range = document.createRange();
  const appendText = (value: string) => {
    const normalized = value.replace(/\s+/g, " ");
    if (!normalized.trim()) return;
    const separator =
      viewportText && !viewportText.endsWith(" ") && !normalized.startsWith(" ") ? " " : "";
    const remaining = maxTextLength - viewportText.length;
    const addition = separator + normalized;
    viewportText += addition.slice(0, remaining);
    if (addition.length > remaining) viewportTextTruncated = true;
  };
  const readText = (node: Text, start: number, end: number, clip: Bounds) => {
    if (viewportTextTruncated || start === end) return;
    range.setStart(node, start);
    range.setEnd(node, end);
    const bounds = range.getBoundingClientRect();
    if (!intersects(bounds, clip)) return;
    if (++rangeReads > 4_096) {
      viewportTextTruncated = true;
      return;
    }
    if (
      bounds.left >= clip.left &&
      bounds.right <= clip.right &&
      bounds.top >= clip.top &&
      bounds.bottom <= clip.bottom
    ) {
      nodeText += node.data.slice(start, end);
      return;
    }
    if (!Array.from(range.getClientRects()).some((rect) => intersects(rect, clip))) return;
    if (end - start === 1) {
      nodeText += node.data.slice(start, end);
      return;
    }
    const middle = start + Math.floor((end - start) / 2);
    readText(node, start, middle, clip);
    readText(node, middle, end, clip);
  };
  if (document.body) {
    if (rendered(document.body)) clipFor(document.body);
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    );
    let node = walker.nextNode();
    let visited = 0;
    while (node) {
      if (++visited > 100_000) {
        viewportTextTruncated = true;
        containersTruncated = true;
        break;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        const style = styleFor(element);
        if (/^(auto|scroll)$/.test(style.overflowX) || /^(auto|scroll)$/.test(style.overflowY)) {
          if (rendered(element) && intersects(element.getBoundingClientRect(), viewport))
            clipFor(element);
        }
        node = walker.nextNode();
        continue;
      }
      const parent = node.parentElement;
      if (
        !viewportTextTruncated &&
        parent &&
        !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName) &&
        rendered(parent)
      ) {
        const clip = clipFor(parent);
        if (clip) {
          nodeText = "";
          readText(node as Text, 0, (node as Text).length, clip);
          appendText(nodeText);
        }
      }
      node = walker.nextNode();
    }
  }
  const visibleText = document.body?.innerText || "";
  const root = document.scrollingElement ?? document.documentElement;
  return {
    url: location.href,
    title: document.title,
    loading: document.readyState !== "complete",
    visibleText: visibleText.slice(0, maxTextLength),
    viewportText: viewportText.trim(),
    interactiveElements,
    scroll: {
      x: scrollX,
      y: scrollY,
      width: innerWidth,
      height: innerHeight,
      scrollWidth: root.scrollWidth,
      scrollHeight: root.scrollHeight,
      containers,
      containersTruncated,
    },
    truncated: {
      visibleText: visibleText.length > maxTextLength,
      viewportText: viewportTextTruncated,
      interactiveElements: elementCount > maxElements,
    },
  };
}

export const snapshotPageExpression = () => `(${collectSnapshotPage.toString()})()`;
