import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";

import { snapshotPageExpression } from "./SnapshotPage.ts";

const rect = (x: number, y: number, width = 100, height = 20) => ({
  x,
  y,
  left: x,
  top: y,
  right: x + width,
  bottom: y + height,
  width,
  height,
});

class PageElement {
  tagName = "DIV";
  id = "";
  innerText = "";
  parentElement: PageElement | null = null;
  offsetParent: PageElement | null = null;
  children: PageElement[] = [];
  clientLeft = 0;
  clientTop = 0;
  clientWidth = 100;
  clientHeight = 20;
  offsetWidth = 100;
  offsetHeight = 20;
  scrollWidth = 100;
  scrollHeight = 20;
  scrollLeft = 0;
  scrollTop = 0;
  bounds = rect(0, 0);
  style = {
    display: "block",
    visibility: "visible",
    opacity: "1",
    contentVisibility: "visible",
    overflowX: "visible",
    overflowY: "visible",
    position: "static",
    transform: "none",
    perspective: "none",
    filter: "none",
    backdropFilter: "none",
    contain: "none",
    willChange: "auto",
    borderRightWidth: "0px",
    borderBottomWidth: "0px",
  };
  getAttribute() {
    return null;
  }
  getBoundingClientRect() {
    return this.bounds;
  }
  checkVisibility(options: { checkVisibilityCSS?: boolean } = {}) {
    const ancestors: PageElement[] = [this];
    if (this.parentElement) ancestors.push(this.parentElement);
    for (let index = 0; index < ancestors.length; index++) {
      const current = ancestors[index]!;
      if (index > 0 && current.parentElement) ancestors.push(current.parentElement);
      if (
        current.style.display === "none" ||
        current.style.opacity === "0" ||
        current.style.contentVisibility === "hidden"
      )
        return false;
    }
    return (
      (!options.checkVisibilityCSS || this.style.visibility === "visible") &&
      this.style.display !== "contents"
    );
  }
}

type PageText = {
  data: string;
  length: number;
  parentElement: PageElement;
  rectangles: (start: number, end: number) => ReturnType<typeof rect>[];
};

const fixture = () => {
  const root = new PageElement();
  const body = new PageElement();
  body.parentElement = root;
  root.children.push(body);
  root.scrollHeight = 10_000;
  const elements: PageElement[] = [];
  const texts: PageText[] = [];
  const element = (id: string, bounds: ReturnType<typeof rect>, parent = body) => {
    const value = new PageElement();
    value.id = id;
    value.bounds = bounds;
    value.parentElement = parent;
    parent.children.push(value);
    return value;
  };
  const text = (
    data: string,
    parent: PageElement,
    rectangles: PageText["rectangles"] = () => [parent.bounds],
  ) => {
    texts.push({ data, length: data.length, parentElement: parent, rectangles });
  };
  let start = 0;
  let end = 0;
  let active: PageText;
  const range = {
    setStart(node: PageText, offset: number) {
      active = node;
      start = offset;
    },
    setEnd(_node: PageText, offset: number) {
      end = offset;
    },
    getClientRects() {
      return active.rectangles(start, end);
    },
    getBoundingClientRect() {
      const rectangles = this.getClientRects();
      const left = Math.min(...rectangles.map((value) => value.left));
      const top = Math.min(...rectangles.map((value) => value.top));
      return rect(
        left,
        top,
        Math.max(...rectangles.map((value) => value.right)) - left,
        Math.max(...rectangles.map((value) => value.bottom)) - top,
      );
    },
  };
  const context = {
    innerWidth: 300,
    innerHeight: 200,
    scrollX: 0,
    scrollY: 4_000,
    location: { href: "https://example.test" },
    CSS: { escape: (value: string) => value },
    HTMLElement: PageElement,
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: (value: PageElement) => value.style,
    document: {
      documentElement: root,
      body,
      scrollingElement: root as PageElement | null,
      title: "Page",
      readyState: "complete",
      compatMode: "CSS1Compat",
      querySelectorAll: () => elements,
      createRange: () => range,
      createTreeWalker() {
        let index = 0;
        return { nextNode: () => texts[index++] ?? null };
      },
    },
  };
  const capture = (scrollingElement: PageElement | null = root, compatMode = "CSS1Compat") => {
    context.document.scrollingElement = scrollingElement;
    context.document.compatMode = compatMode;
    return NodeVM.runInNewContext(snapshotPageExpression(), context) as ReturnType<
      typeof import("./SnapshotPage.ts").collectSnapshotPage
    >;
  };
  return { root, body, elements, texts, element, text, capture };
};

describe("snapshot page collector", () => {
  it("keeps bottom text after more than 4096 offscreen paragraphs", () => {
    const page = fixture();
    for (let index = 0; index < 5_000; index++) {
      page.text("offscreen", page.element(`paragraph-${index}`, rect(0, -100)));
    }
    page.text("bottom marker", page.element("bottom", rect(0, 100)));
    const snapshot = page.capture();
    expect(snapshot.viewportText).toBe("bottom marker");
    expect(snapshot.truncated?.viewportText).toBe(false);
  });

  it("reads direct display:contents text while respecting hidden ancestors", () => {
    const page = fixture();
    const contents = page.element("contents", rect(0, 0, 0, 0));
    contents.style.display = "contents";
    page.text("direct contents text", contents, () => [rect(0, 20)]);
    const hidden = page.element("hidden", rect(0, 40));
    hidden.style.opacity = "0";
    const hiddenContents = page.element("hidden-contents", rect(0, 0, 0, 0), hidden);
    hiddenContents.style.display = "contents";
    page.text("hidden contents text", hiddenContents, () => [rect(0, 40)]);
    const visibility = page.element("visibility", rect(0, 60));
    visibility.style.visibility = "hidden";
    const override = page.element("override", rect(0, 0, 0, 0), visibility);
    override.style.display = "contents";
    page.text("visible override", override, () => [rect(0, 60)]);
    expect(page.capture().viewportText).toBe("direct contents text visible override");
  });

  it("captures text under deeply nested ancestors without recursive stack growth", () => {
    const page = fixture();
    let parent = page.body;
    for (let index = 0; index < 5_000; index++)
      parent = page.element(`nested-${index}`, rect(0, 100), parent);
    page.text("deep text", parent);
    expect(page.capture().viewportText).toBe("deep text");
  });

  it("clips an independently scrolling body in standard and quirks documents", () => {
    const page = fixture();
    page.root.style.overflowY = "hidden";
    page.body.style.overflowY = "auto";
    page.body.bounds = rect(0, 0, 300, 100);
    page.body.clientWidth = page.body.offsetWidth = 300;
    page.body.clientHeight = page.body.offsetHeight = 100;
    page.body.scrollHeight = 1_000;
    page.body.scrollTop = 200;
    const clipped = page.element("body-clipped", rect(0, 140));
    page.elements.push(clipped);
    page.text("clipped body text", clipped);
    for (const scrollingElement of [page.root, null]) {
      const snapshot = page.capture(scrollingElement);
      expect(snapshot.viewportText).toBe("");
      expect(snapshot.interactiveElements[0]?.inViewport).toBe(false);
      expect(snapshot.scroll?.containers[0]).toMatchObject({
        selector: "div > div",
        y: 200,
        height: 100,
        scrollHeight: 1_000,
      });
    }
  });

  it("uses the actual body box when quirks client dimensions report the viewport", () => {
    const page = fixture();
    page.root.style.overflowX = page.root.style.overflowY = "hidden";
    page.body.style.overflowX = page.body.style.overflowY = "auto";
    page.body.bounds = rect(0, 0, 200, 200);
    page.body.clientWidth = 300;
    page.body.clientHeight = 800;
    page.body.offsetWidth = page.body.offsetHeight = 100;
    page.body.clientLeft = page.body.clientTop = 2;
    page.body.style.borderRightWidth = page.body.style.borderBottomWidth = "2px";
    page.body.scrollWidth = 300;
    page.body.scrollHeight = 245;
    const vertical = page.element("vertical", rect(10, 198, 50, 2));
    const horizontal = page.element("horizontal", rect(198, 10, 2, 50));
    page.elements.push(vertical, horizontal);
    page.text("vertical text", vertical);
    page.text("horizontal text", horizontal);
    const snapshot = page.capture(null, "BackCompat");
    expect(snapshot.viewportText).toBe("");
    expect(snapshot.interactiveElements.every((element) => element.inViewport === false)).toBe(
      true,
    );
    expect(snapshot.scroll?.containers[0]).toMatchObject({
      width: 96,
      height: 96,
      scrollWidth: 300,
      scrollHeight: 245,
    });
    page.body.offsetHeight = 1_000;
    page.body.bounds = rect(0, 0, 200, 2_000);
    page.body.scrollHeight = 2_000;
    expect(page.capture(null, "BackCompat").scroll?.containers[0]?.height).toBe(996);
  });

  it("keeps current controls ahead of more than 200 offscreen controls", () => {
    const page = fixture();
    for (let index = 0; index < 240; index++) {
      const control = page.element(`button-${index}`, rect(0, index < 239 ? -1_000 : 100));
      control.tagName = "BUTTON";
      page.elements.push(control);
    }
    page.body.innerText = "whole page ".repeat(3_000);
    page.text("on screen", page.elements[239]!);
    const snapshot = page.capture();
    expect(snapshot.interactiveElements).toHaveLength(200);
    expect(snapshot.interactiveElements[0]).toMatchObject({
      selector: "#button-239",
      inViewport: true,
    });
    expect(snapshot.viewportText).toBe("on screen");
    expect(snapshot.visibleText).toHaveLength(20_000);
    expect(snapshot.truncated).toEqual({
      visibleText: true,
      viewportText: false,
      interactiveElements: true,
    });
    expect(snapshot.scroll).toMatchObject({ y: 4_000, height: 200, scrollHeight: 10_000 });
  });

  it("clips nested scroll text and controls without changing scroll offsets", () => {
    const page = fixture();
    const outer = page.element("outer", rect(10, 10, 100, 100));
    outer.clientHeight = 100;
    outer.offsetHeight = 100;
    outer.style.overflowY = "auto";
    outer.scrollHeight = 1_000;
    outer.scrollTop = 600;
    const inner = page.element("inner", rect(20, 30, 80, 40), outer);
    inner.clientWidth = inner.offsetWidth = 80;
    inner.clientHeight = inner.offsetHeight = 40;
    inner.style.overflowX = "hidden";
    inner.style.overflowY = "clip";
    const visible = page.element("visible", rect(20, 35, 70, 20), inner);
    const clipped = page.element("clipped", rect(20, 80, 70, 20), inner);
    page.elements.push(clipped, visible);
    page.text("visible words", visible);
    page.text("hidden under scroll", clipped);
    const snapshot = page.capture();
    expect(snapshot.viewportText).toBe("visible words");
    expect(snapshot.interactiveElements[0]).toMatchObject({
      selector: "#visible",
      inViewport: true,
    });
    expect(snapshot.interactiveElements[1]).toMatchObject({
      selector: "#clipped",
      inViewport: false,
    });
    expect(snapshot.scroll?.containers).toEqual([
      {
        selector: "#outer",
        x: 0,
        y: 600,
        width: 100,
        height: 100,
        scrollWidth: 100,
        scrollHeight: 1_000,
      },
    ]);
    expect(outer.scrollTop).toBe(600);
  });

  it("reads only visible characters from a huge wrapped text node", () => {
    const page = fixture();
    const parent = page.element("long", rect(0, -100_000, 100, 200_000));
    const data = "x".repeat(100_000) + "VISIBLE" + "z".repeat(100_000);
    page.text(data, parent, (start: number, end: number) => {
      const rectangles = [];
      if (start < 100_000) rectangles.push(rect(0, -100, 100, 20));
      if (end > 100_000 && start < 100_007) rectangles.push(rect(0, 100, 100, 20));
      if (end > 100_007) rectangles.push(rect(0, 500, 100, 20));
      return rectangles;
    });
    expect(page.capture().viewportText).toBe("VISIBLE");
  });

  it("clips positioned descendants at their containing block", () => {
    const page = fixture();
    const scroller = page.element("scroller", rect(0, 0));
    scroller.style.overflowY = "auto";
    scroller.scrollHeight = 1_000;
    const fixed = page.element("fixed", rect(180, 100), scroller);
    fixed.style.position = "fixed";
    const absolute = page.element("absolute", rect(0, 140), scroller);
    absolute.style.position = "absolute";
    absolute.offsetParent = page.body;
    const transformed = page.element("transformed", rect(0, 0));
    transformed.style.overflowY = "hidden";
    transformed.style.transform = "translateX(0px)";
    const clipped = page.element("clipped", rect(0, 160), transformed);
    clipped.style.position = "fixed";
    clipped.offsetParent = transformed;
    page.elements.push(fixed, absolute, clipped);
    page.text("fixed label", fixed);
    page.text("absolute label", absolute);
    page.text("clipped label", clipped);
    const snapshot = page.capture();
    expect(snapshot.viewportText).toBe("fixed label absolute label");
    expect(
      snapshot.interactiveElements.map((element) => [element.selector, element.inViewport]),
    ).toEqual([
      ["#fixed", true],
      ["#absolute", true],
      ["#clipped", false],
    ]);
  });

  it("omits hidden styles and clips horizontal text", () => {
    const page = fixture();
    const transparent = page.element("transparent", rect(0, 0));
    transparent.style.opacity = "0";
    const hidden = page.element("hidden", rect(0, 20));
    hidden.style.contentVisibility = "hidden";
    const visibility = page.element("visibility", rect(0, 40));
    visibility.style.visibility = "hidden";
    for (const parent of [transparent, hidden, visibility]) page.text("secret", parent);
    const clipped = page.element("horizontal", rect(-100, 60, 500, 20));
    page.text("abcdefghijklmnopqrst", clipped, (start: number, end: number) => [
      rect(-100 + start * 25, 60, (end - start) * 25, 20),
    ]);
    expect(page.capture().viewportText).toBe("efghijklmnop");
  });

  it("reports capped viewport text and scroll container metadata", () => {
    const page = fixture();
    for (let index = 0; index < 21; index++) {
      const container = page.element(`scroll-${index}`, rect(0, 0));
      container.style.overflowY = "scroll";
      container.scrollHeight = 100;
      page.text("text", container);
    }
    const large = page.element("large", rect(0, 100));
    page.text("x".repeat(25_000), large);
    const snapshot = page.capture();
    expect(snapshot.scroll?.containers).toHaveLength(20);
    expect(snapshot.scroll?.containersTruncated).toBe(true);
    expect(snapshot.viewportText).toHaveLength(20_000);
    expect(snapshot.truncated?.viewportText).toBe(true);
  });

  it("omits oversized scroll selectors while preserving current text", () => {
    const page = fixture();
    const container = page.element("x".repeat(2_000), rect(0, 0));
    container.style.overflowY = "scroll";
    container.scrollHeight = 1_000;
    page.text("current text", container);
    const snapshot = page.capture();
    expect(snapshot.viewportText).toBe("current text");
    expect(snapshot.scroll?.containers).toEqual([]);
    expect(snapshot.scroll?.containersTruncated).toBe(true);
  });
});
