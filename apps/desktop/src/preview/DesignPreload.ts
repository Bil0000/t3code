import { ipcRenderer } from "electron";
import type { DesktopPreviewDesignChangePayload } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  createDesignSelectionAnnotation,
  DESIGN_EDITING_ATTRIBUTE,
  DESIGN_UI_ATTRIBUTE,
  designPathFromUrl,
  resolveDesignPosition,
  serializeDesignDocument,
} from "./DesignDocument.ts";
import { DESIGN_CHANGED_CHANNEL } from "./GuestProtocol.ts";

type Tool = "select" | "draw" | "arrow" | "box" | "circle" | "highlight";
type Point = { x: number; y: number };
type ElementState = {
  style: string;
  text: string | null;
  x: string | null;
  y: string | null;
};
type HistoryEntry = { undo: () => void; redo: () => void };
type DragState =
  | {
      kind: "move";
      element: HTMLElement | SVGElement;
      start: Point;
      x: number;
      y: number;
      before: ElementState;
    }
  | {
      kind: "resize";
      element: HTMLElement | SVGElement;
      start: Point;
      width: number;
      height: number;
      x: number;
      y: number;
      direction: string;
      before: ElementState;
    }
  | {
      kind: "create";
      tool: Exclude<Tool, "select">;
      start: Point;
      element: HTMLElement | SVGSVGElement;
      points: Point[];
    };

const OBJECT_ATTRIBUTE = "data-t3-design-object";
const FOCUS_ATTRIBUTE = "data-t3-design-focus";
const SELECTED_ATTRIBUTE = "data-t3-design-selected";
const ARTBOARD_SELECTOR = "[data-t3-design-artboard]";
const SAVE_DELAY_MS = 200;
const MIN_SHAPE_SIZE = 5;
let idSequence = 0;

function nextId(): string {
  let id: string;
  do {
    idSequence += 1;
    id = `manual-${idSequence}`;
  } while (document.querySelector(`[data-t3-design-id="${id}"]`));
  return id;
}

function isUiElement(value: EventTarget | null): boolean {
  return value instanceof Element && value.closest(`[${DESIGN_UI_ATTRIBUTE}]`) !== null;
}

function targetFromPoint(x: number, y: number): Element | null {
  const target = document
    .elementsFromPoint(x, y)
    .find(
      (element) =>
        !isUiElement(element) &&
        element !== document.documentElement &&
        element !== document.body &&
        !["SCRIPT", "STYLE", "LINK", "META"].includes(element.tagName),
    );
  return target?.closest(`[${OBJECT_ATTRIBUTE}]`) ?? target ?? null;
}

function stateOf(element: HTMLElement | SVGElement): ElementState {
  return {
    style: element.style.cssText,
    text: element.childElementCount === 0 ? element.textContent : null,
    x: element.getAttribute("data-t3-design-x"),
    y: element.getAttribute("data-t3-design-y"),
  };
}

function applyState(element: HTMLElement | SVGElement, state: ElementState): void {
  element.style.cssText = state.style;
  if (state.text !== null && element.childElementCount === 0) element.textContent = state.text;
  for (const [name, value] of [
    ["data-t3-design-x", state.x],
    ["data-t3-design-y", state.y],
  ] as const) {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }
}

function statesMatch(left: ElementState, right: ElementState): boolean {
  return (
    left.style === right.style &&
    left.text === right.text &&
    left.x === right.x &&
    left.y === right.y
  );
}

function pagePoint(event: PointerEvent): Point {
  return { x: event.clientX + window.scrollX, y: event.clientY + window.scrollY };
}

function positionOf(element: Element): Point {
  const rect = element.getBoundingClientRect();
  return resolveDesignPosition(
    element.getAttribute("data-t3-design-x"),
    element.getAttribute("data-t3-design-y"),
    getComputedStyle(element).translate,
    rect.width,
    rect.height,
  );
}

function rgbToHex(value: string, fallback: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  const parts = value
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number);
  return parts?.length === 3
    ? `#${parts
        .map((part) =>
          Math.max(0, Math.min(255, Math.round(part)))
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")}`
    : fallback;
}

function startDesignEditor(): void {
  if (!designPathFromUrl(location.href) || document.querySelector(`[${DESIGN_UI_ATTRIBUTE}]`))
    return;

  const host = document.createElement("div");
  host.setAttribute(DESIGN_UI_ATTRIBUTE, "");
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host{color-scheme:light dark;font:12px/1.35 ui-sans-serif,system-ui,sans-serif;color:light-dark(#171717,#f5f5f5)}
    *{box-sizing:border-box}
    button,input,textarea{font:inherit;color:inherit}
    button{height:28px;border:0;border-radius:7px;background:transparent;padding:0 9px;cursor:pointer;white-space:nowrap}
    button:hover:not(:disabled){background:light-dark(#eee,#333)}
    button[aria-pressed=true]{background:#2563eb;color:white}
    button:disabled{opacity:.35;cursor:default}
    .toolbar,.inspector{pointer-events:auto;position:fixed;border:1px solid light-dark(#d9d9d9,#3d3d3d);background:light-dark(rgba(255,255,255,.96),rgba(24,24,24,.96));box-shadow:0 10px 30px rgba(0,0,0,.18);backdrop-filter:blur(18px)}
    .toolbar{top:10px;left:50%;transform:translateX(-50%);display:flex;flex-wrap:wrap;justify-content:center;gap:2px;max-width:calc(100vw - 20px);padding:5px;border-radius:10px}
    .sep{width:1px;margin:4px 2px;background:light-dark(#ddd,#444)}
    .selection{display:none;pointer-events:none;position:fixed;z-index:1;border:2px solid #2563eb;box-shadow:0 0 0 1px white;border-radius:3px}
    .tag{position:absolute;left:-2px;bottom:calc(100% + 5px);max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:5px;background:#2563eb;color:white;padding:3px 6px}
    .attach{pointer-events:auto;position:absolute;left:50%;top:-14px;width:26px;height:26px;transform:translateX(-50%);border:2px solid white;border-radius:999px;background:#22c55e;color:white;padding:0;font-size:18px;line-height:20px;box-shadow:0 2px 8px rgba(0,0,0,.22)}
    .handle{pointer-events:auto;position:absolute;width:10px;height:10px;border:2px solid white;border-radius:3px;background:#2563eb;padding:0}
    .nw{left:-6px;top:-6px;cursor:nwse-resize}.ne{right:-6px;top:-6px;cursor:nesw-resize}.sw{left:-6px;bottom:-6px;cursor:nesw-resize}.se{right:-6px;bottom:-6px;cursor:nwse-resize}
    .inspector{display:none;right:10px;top:54px;width:220px;padding:10px;border-radius:11px}
    .inspector h2{margin:0 0 8px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .field{display:grid;grid-template-columns:62px minmax(0,1fr);align-items:center;gap:7px;margin-top:6px;color:light-dark(#666,#aaa)}
    .field input,.field textarea{min-width:0;width:100%;border:1px solid light-dark(#ddd,#444);border-radius:6px;background:light-dark(#fff,#222);padding:5px 7px;outline:none}
    .field input{height:28px}.field input[type=color]{padding:3px}.field textarea{height:54px;resize:vertical}
    .hint{margin-top:8px;color:light-dark(#777,#999)}
  `;
  root.appendChild(style);

  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  const selection = document.createElement("div");
  selection.className = "selection";
  const tag = document.createElement("div");
  tag.className = "tag";
  const attach = document.createElement("button");
  attach.type = "button";
  attach.className = "attach";
  attach.textContent = "+";
  attach.title = "Attach selection to chat";
  attach.setAttribute("aria-label", "Attach selection to chat");
  selection.append(tag, attach);
  const inspector = document.createElement("div");
  inspector.className = "inspector";
  const inspectorTitle = document.createElement("h2");
  inspector.appendChild(inspectorTitle);
  root.append(toolbar, selection, inspector);

  const toolButtons = new Map<Tool, HTMLButtonElement>();
  let tool: Tool = "select";
  let selected: HTMLElement | SVGElement | null = null;
  let drag: DragState | null = null;
  let history: HistoryEntry[] = [];
  let historyIndex = 0;
  let saveTimer: number | null = null;

  const save = (annotation?: DesktopPreviewDesignChangePayload["annotation"]): void => {
    saveTimer = null;
    const payload: DesktopPreviewDesignChangePayload = {
      html: serializeDesignDocument(document),
      ...(annotation ? { annotation } : {}),
    };
    ipcRenderer.send(DESIGN_CHANGED_CHANNEL, payload);
  };

  const scheduleSave = (): void => {
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(save, SAVE_DELAY_MS);
  };

  const flushSave = (): void => {
    if (saveTimer === null) return;
    window.clearTimeout(saveTimer);
    save();
  };

  const refreshHistoryButtons = (): void => {
    undo.disabled = historyIndex === 0;
    redo.disabled = historyIndex === history.length;
  };

  const pushHistory = (entry: HistoryEntry): void => {
    history = [...history.slice(0, historyIndex), entry];
    historyIndex = history.length;
    refreshHistoryButtons();
  };

  const setFieldValue = (field: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
    if (root.activeElement !== field) field.value = value;
  };

  const refreshSelection = (): void => {
    if (!selected?.isConnected) {
      selected = null;
      selection.style.display = "none";
      inspector.style.display = "none";
      remove.disabled = true;
      choose.disabled = true;
      return;
    }
    const rect = selected.getBoundingClientRect();
    selection.style.display = "block";
    selection.style.transform = `translate(${rect.left}px,${rect.top}px)`;
    selection.style.width = `${rect.width}px`;
    selection.style.height = `${rect.height}px`;
    tag.textContent =
      selected.getAttribute("data-t3-design-id") ??
      selected.getAttribute(OBJECT_ATTRIBUTE) ??
      selected.tagName.toLowerCase();
    inspector.style.display = "block";
    inspectorTitle.textContent = tag.textContent;
    remove.disabled = false;
    choose.disabled = false;
    const computed = getComputedStyle(selected);
    textValue.disabled = selected.childElementCount > 0;
    setFieldValue(textValue, selected.childElementCount === 0 ? (selected.textContent ?? "") : "");
    setFieldValue(fill, rgbToHex(computed.backgroundColor, "#ffffff"));
    setFieldValue(color, rgbToHex(computed.color, "#111111"));
    setFieldValue(fontSize, String(Math.round(Number.parseFloat(computed.fontSize) || 16)));
    setFieldValue(radius, String(Math.round(Number.parseFloat(computed.borderRadius) || 0)));
    setFieldValue(opacity, computed.opacity);
    setFieldValue(width, String(Math.round(rect.width)));
    setFieldValue(height, String(Math.round(rect.height)));
    choose.textContent = findArtboard(selected)?.hasAttribute(SELECTED_ATTRIBUTE)
      ? "Chosen"
      : "Choose";
  };

  const selectElement = (element: Element | null, persist = true): void => {
    document
      .querySelectorAll(`[${FOCUS_ATTRIBUTE}]`)
      .forEach((candidate) => candidate.removeAttribute(FOCUS_ATTRIBUTE));
    selected = element instanceof HTMLElement || element instanceof SVGElement ? element : null;
    if (selected && !selected.hasAttribute("data-t3-design-id")) {
      selected.setAttribute("data-t3-design-id", nextId());
    }
    selected?.setAttribute(FOCUS_ATTRIBUTE, "true");
    refreshSelection();
    if (persist) scheduleSave();
  };

  attach.addEventListener("click", (event) => {
    if (!selected) return;
    const id = selected.getAttribute("data-t3-design-id");
    if (!id) return;
    const rect = selected.getBoundingClientRect();
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    save(
      createDesignSelectionAnnotation({
        id,
        pageUrl: location.href,
        pageTitle: document.title?.trim() || null,
        tagName: selected.tagName.toLowerCase(),
        selector: `[data-t3-design-id="${CSS.escape(id)}"]`,
        htmlPreview: selected.outerHTML.slice(0, 4_000),
        styles: selected.getAttribute("style") ?? "",
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
      }),
    );
    attach.textContent = "✓";
    window.setTimeout(() => {
      attach.textContent = "+";
    }, 900);
    event.preventDefault();
    event.stopPropagation();
  });

  const commitElementState = (element: HTMLElement | SVGElement, before: ElementState): void => {
    const after = stateOf(element);
    if (statesMatch(before, after)) return;
    pushHistory({
      undo: () => applyState(element, before),
      redo: () => applyState(element, after),
    });
    scheduleSave();
  };

  const runHistory = (direction: -1 | 1): void => {
    const entry = direction < 0 ? history[historyIndex - 1] : history[historyIndex];
    if (!entry) return;
    if (direction < 0) {
      historyIndex -= 1;
      entry.undo();
    } else {
      entry.redo();
      historyIndex += 1;
    }
    refreshHistoryButtons();
    refreshSelection();
    scheduleSave();
  };

  const button = (label: string, action: () => void): HTMLButtonElement => {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.addEventListener("click", action);
    toolbar.appendChild(element);
    return element;
  };

  const separator = (): void => {
    const element = document.createElement("span");
    element.className = "sep";
    toolbar.appendChild(element);
  };

  const setTool = (next: Tool): void => {
    tool = next;
    for (const [candidate, element] of toolButtons) {
      element.setAttribute("aria-pressed", String(candidate === tool));
    }
    document.documentElement.style.cursor = tool === "select" ? "default" : "crosshair";
  };

  for (const [value, label] of [
    ["select", "Select"],
    ["draw", "Draw"],
    ["arrow", "Arrow"],
    ["box", "Box"],
    ["circle", "Circle"],
    ["highlight", "Highlight"],
  ] as const) {
    const element = button(label, () => setTool(value));
    element.setAttribute("aria-pressed", "false");
    toolButtons.set(value, element);
  }

  separator();
  const undo = button("Undo", () => runHistory(-1));
  const redo = button("Redo", () => runHistory(1));
  separator();

  const designLayer = (): HTMLDivElement => {
    let layer = document.querySelector<HTMLDivElement>(`[${OBJECT_ATTRIBUTE}="layer"]`);
    if (!layer) {
      layer = document.createElement("div");
      layer.setAttribute(OBJECT_ATTRIBUTE, "layer");
      layer.setAttribute("data-t3-design-id", nextId());
      layer.style.cssText =
        "position:absolute;inset:0 0 auto 0;min-height:100%;pointer-events:none;z-index:2147483000";
      document.body.appendChild(layer);
    }
    layer.style.height = `${Math.max(document.documentElement.scrollHeight, window.innerHeight)}px`;
    return layer;
  };

  const addObject = (element: HTMLElement | SVGElement): void => {
    const layer = designLayer();
    layer.appendChild(element);
    pushHistory({
      undo: () => element.remove(),
      redo: () => layer.appendChild(element),
    });
    selectElement(element);
  };

  const baseObject = (kind: string, x: number, y: number): HTMLDivElement => {
    const element = document.createElement("div");
    element.setAttribute(OBJECT_ATTRIBUTE, kind);
    element.setAttribute("data-t3-design-id", nextId());
    element.style.cssText = `position:absolute;left:${x}px;top:${y}px;pointer-events:auto;box-sizing:border-box`;
    return element;
  };

  const addText = (note = false): void => {
    const x = window.scrollX + Math.max(24, window.innerWidth / 2 - 90);
    const y = window.scrollY + Math.max(70, window.innerHeight / 2 - 40);
    const element = baseObject(note ? "note" : "text", x, y);
    element.textContent = note ? "Add a note" : "Edit text";
    element.style.cssText += note
      ? ";width:180px;min-height:90px;padding:14px;border-radius:10px;background:#fef08a;color:#422006;box-shadow:0 8px 20px rgba(0,0,0,.15)"
      : ";padding:6px 8px;color:#111;font:600 18px/1.3 system-ui;background:transparent";
    addObject(element);
  };

  button("Text", () => addText());
  button("Note", () => addText(true));

  const findArtboard = (element: Element): Element | null => {
    const marked = element.closest(ARTBOARD_SELECTOR);
    if (marked) return marked;
    let candidate = element;
    while (candidate.parentElement && candidate.parentElement !== document.body) {
      candidate = candidate.parentElement;
    }
    return candidate.hasAttribute(OBJECT_ATTRIBUTE) ? null : candidate;
  };

  const choose = button("Choose", () => {
    if (!selected) return;
    const artboard = findArtboard(selected);
    if (!artboard) return;
    const previous = document.querySelector(`[${SELECTED_ATTRIBUTE}]`);
    if (previous === artboard) return;
    const apply = (choice: Element | null): void => {
      document
        .querySelectorAll(`[${SELECTED_ATTRIBUTE}]`)
        .forEach((element) => element.removeAttribute(SELECTED_ATTRIBUTE));
      choice?.setAttribute(SELECTED_ATTRIBUTE, "true");
    };
    apply(artboard);
    pushHistory({ undo: () => apply(previous), redo: () => apply(artboard) });
    refreshSelection();
    scheduleSave();
  });

  const remove = button("Delete", () => {
    const element = selected;
    const parent = element?.parentNode;
    if (!element || !parent) return;
    const next = element.nextSibling;
    const detach = (): void => {
      if (selected === element) selectElement(null);
      element.removeAttribute(FOCUS_ATTRIBUTE);
      element.remove();
    };
    detach();
    pushHistory({
      undo: () => parent.insertBefore(element, next?.parentNode === parent ? next : null),
      redo: detach,
    });
    scheduleSave();
  });

  function field(label: string, input: HTMLInputElement | HTMLTextAreaElement): void {
    const wrapper = document.createElement("label");
    wrapper.className = "field";
    const name = document.createElement("span");
    name.textContent = label;
    wrapper.append(name, input);
    inspector.appendChild(wrapper);
  }

  const textValue = document.createElement("textarea");
  const fill = document.createElement("input");
  const color = document.createElement("input");
  const fontSize = document.createElement("input");
  const radius = document.createElement("input");
  const opacity = document.createElement("input");
  const width = document.createElement("input");
  const height = document.createElement("input");
  fill.type = color.type = "color";
  for (const input of [fontSize, radius, opacity, width, height]) input.type = "number";
  opacity.min = "0";
  opacity.max = "1";
  opacity.step = "0.05";
  field("Text", textValue);
  field("Fill", fill);
  field("Color", color);
  field("Size", fontSize);
  field("Radius", radius);
  field("Opacity", opacity);
  field("Width", width);
  field("Height", height);
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "Drag selected items. Double-click text to edit.";
  inspector.appendChild(hint);

  const bindField = (
    input: HTMLInputElement | HTMLTextAreaElement,
    update: (element: HTMLElement | SVGElement, value: string) => void,
  ): void => {
    let target: HTMLElement | SVGElement | null = null;
    let before: ElementState | null = null;
    input.addEventListener("focus", () => {
      target = selected;
      before = target ? stateOf(target) : null;
    });
    input.addEventListener("input", () => {
      if (!target || target !== selected) return;
      update(target, input.value);
      refreshSelection();
      scheduleSave();
    });
    input.addEventListener("change", () => {
      if (target && before) commitElementState(target, before);
      target = null;
      before = null;
    });
  };

  bindField(textValue, (element, value) => {
    if (element.childElementCount === 0) element.textContent = value;
  });
  bindField(fill, (element, value) => element.style.setProperty("background-color", value));
  bindField(color, (element, value) => element.style.setProperty("color", value));
  bindField(fontSize, (element, value) => element.style.setProperty("font-size", `${value}px`));
  bindField(radius, (element, value) => element.style.setProperty("border-radius", `${value}px`));
  bindField(opacity, (element, value) => element.style.setProperty("opacity", value));
  bindField(width, (element, value) => element.style.setProperty("width", `${value}px`));
  bindField(height, (element, value) => element.style.setProperty("height", `${value}px`));

  for (const direction of ["nw", "ne", "sw", "se"]) {
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = `handle ${direction}`;
    handle.setAttribute("aria-label", `Resize ${direction}`);
    handle.addEventListener("pointerdown", (event) => {
      if (!selected || event.button !== 0) return;
      handle.setPointerCapture(event.pointerId);
      const rect = selected.getBoundingClientRect();
      const position = positionOf(selected);
      drag = {
        kind: "resize",
        element: selected,
        start: { x: event.clientX, y: event.clientY },
        width: rect.width,
        height: rect.height,
        x: position.x,
        y: position.y,
        direction,
        before: stateOf(selected),
      };
      event.preventDefault();
      event.stopPropagation();
    });
    selection.appendChild(handle);
  }

  const positionShape = (element: HTMLElement, start: Point, end: Point): void => {
    element.style.left = `${Math.min(start.x, end.x)}px`;
    element.style.top = `${Math.min(start.y, end.y)}px`;
    element.style.width = `${Math.abs(end.x - start.x)}px`;
    element.style.height = `${Math.abs(end.y - start.y)}px`;
  };

  const renderSvg = (svg: SVGSVGElement, points: Point[], arrow: boolean): void => {
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const left = Math.min(...xs) - 8;
    const top = Math.min(...ys) - 8;
    const widthValue = Math.max(16, Math.max(...xs) - Math.min(...xs) + 16);
    const heightValue = Math.max(16, Math.max(...ys) - Math.min(...ys) + 16);
    svg.style.left = `${left}px`;
    svg.style.top = `${top}px`;
    svg.style.width = `${widthValue}px`;
    svg.style.height = `${heightValue}px`;
    svg.setAttribute("viewBox", `0 0 ${widthValue} ${heightValue}`);
    const local = points.map((point) => ({ x: point.x - left, y: point.y - top }));
    if (!arrow) {
      svg.innerHTML = `<path d="${local.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ")}" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
      return;
    }
    const start = local[0]!;
    const end = local.at(-1)!;
    const length = Math.max(1, Math.hypot(end.x - start.x, end.y - start.y));
    const ux = (end.x - start.x) / length;
    const uy = (end.y - start.y) / length;
    const baseX = end.x - ux * 13;
    const baseY = end.y - uy * 13;
    const wing = 6;
    svg.innerHTML = `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><polygon points="${end.x},${end.y} ${baseX - uy * wing},${baseY + ux * wing} ${baseX + uy * wing},${baseY - ux * wing}" fill="currentColor"/>`;
  };

  const beginCreation = (event: PointerEvent, creationTool: Exclude<Tool, "select">): void => {
    const start = pagePoint(event);
    if (creationTool === "draw" || creationTool === "arrow") {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute(OBJECT_ATTRIBUTE, creationTool);
      svg.setAttribute("data-t3-design-id", nextId());
      svg.style.cssText = "position:absolute;pointer-events:auto;overflow:visible;color:#ef4444";
      designLayer().appendChild(svg);
      drag = { kind: "create", tool: creationTool, start, element: svg, points: [start] };
      renderSvg(svg, [start, start], creationTool === "arrow");
      return;
    }
    const element = baseObject(creationTool, start.x, start.y);
    if (creationTool === "box")
      element.style.cssText += ";border:3px solid #ef4444;background:transparent";
    if (creationTool === "circle")
      element.style.cssText +=
        ";border:3px solid #ef4444;border-radius:9999px;background:transparent";
    if (creationTool === "highlight")
      element.style.cssText += ";border-radius:4px;background:rgba(250,204,21,.42)";
    designLayer().appendChild(element);
    drag = { kind: "create", tool: creationTool, start, element, points: [start] };
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || isUiElement(event.target)) return;
    if (event.target instanceof Element) event.target.setPointerCapture(event.pointerId);
    if (tool !== "select") {
      beginCreation(event, tool);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = targetFromPoint(event.clientX, event.clientY);
    if (target && target === selected) {
      const position = positionOf(selected);
      drag = {
        kind: "move",
        element: selected,
        start: { x: event.clientX, y: event.clientY },
        x: position.x,
        y: position.y,
        before: stateOf(selected),
      };
    } else {
      selectElement(target);
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!drag) return;
    if (drag.kind === "move") {
      const x = drag.x + event.clientX - drag.start.x;
      const y = drag.y + event.clientY - drag.start.y;
      drag.element.setAttribute("data-t3-design-x", String(Math.round(x)));
      drag.element.setAttribute("data-t3-design-y", String(Math.round(y)));
      drag.element.style.translate = `${x}px ${y}px`;
    } else if (drag.kind === "resize") {
      const west = drag.direction.includes("w");
      const north = drag.direction.includes("n");
      const nextWidth = Math.max(8, drag.width + (event.clientX - drag.start.x) * (west ? -1 : 1));
      const nextHeight = Math.max(
        8,
        drag.height + (event.clientY - drag.start.y) * (north ? -1 : 1),
      );
      const x = west ? drag.x + drag.width - nextWidth : drag.x;
      const y = north ? drag.y + drag.height - nextHeight : drag.y;
      drag.element.style.width = `${nextWidth}px`;
      drag.element.style.height = `${nextHeight}px`;
      drag.element.style.translate = `${x}px ${y}px`;
      drag.element.setAttribute("data-t3-design-x", String(Math.round(x)));
      drag.element.setAttribute("data-t3-design-y", String(Math.round(y)));
    } else {
      const end = pagePoint(event);
      if (drag.element instanceof SVGSVGElement) {
        if (drag.tool === "draw") drag.points.push(end);
        else drag.points = [drag.start, end];
        renderSvg(drag.element, drag.points, drag.tool === "arrow");
      } else {
        positionShape(drag.element, drag.start, end);
      }
    }
    refreshSelection();
    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!drag) return;
    const completed = drag;
    drag = null;
    if (completed.kind === "move" || completed.kind === "resize") {
      commitElementState(completed.element, completed.before);
    } else {
      const rect = completed.element.getBoundingClientRect();
      if (rect.width < MIN_SHAPE_SIZE || rect.height < MIN_SHAPE_SIZE) completed.element.remove();
      else {
        const element = completed.element;
        const layer = element.parentNode!;
        pushHistory({ undo: () => element.remove(), redo: () => layer.appendChild(element) });
        selectElement(element);
      }
      setTool("select");
    }
    refreshSelection();
    event.preventDefault();
    event.stopPropagation();
  };

  const editText = (event: MouseEvent): void => {
    if (tool !== "select" || isUiElement(event.target)) return;
    const target = targetFromPoint(event.clientX, event.clientY);
    if (!(target instanceof HTMLElement) || target.childElementCount > 0) return;
    const before = stateOf(target);
    target.setAttribute(DESIGN_EDITING_ATTRIBUTE, "");
    target.contentEditable = "true";
    target.focus();
    const finish = (): void => {
      target.removeAttribute(DESIGN_EDITING_ATTRIBUTE);
      target.removeAttribute("contenteditable");
      commitElementState(target, before);
      refreshSelection();
    };
    target.addEventListener("blur", finish, { once: true });
    event.preventDefault();
    event.stopPropagation();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const typing =
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      (event.target instanceof HTMLElement && event.target.isContentEditable);
    if (typing) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      runHistory(event.shiftKey ? 1 : -1);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Delete" || event.key === "Backspace") remove.click();
    else if (event.key === "Escape" || event.key.toLowerCase() === "v") setTool("select");
    else if (event.key.toLowerCase() === "d") setTool("draw");
    else if (event.key.toLowerCase() === "a") setTool("arrow");
    else if (event.key.toLowerCase() === "b") setTool("box");
    else if (event.key.toLowerCase() === "c") setTool("circle");
    else if (event.key.toLowerCase() === "h") setTool("highlight");
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const preventNavigation = (event: MouseEvent): void => {
    if (tool === "select" && !isUiElement(event.target)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerUp, true);
  window.addEventListener("click", preventNavigation, true);
  window.addEventListener("dblclick", editText, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("pagehide", flushSave, { once: true });
  window.addEventListener("scroll", refreshSelection, { capture: true, passive: true });
  window.addEventListener("resize", refreshSelection, { passive: true });
  document.documentElement.appendChild(host);
  setTool("select");
  refreshHistoryButtons();
  selectElement(document.querySelector(`[${FOCUS_ATTRIBUTE}]`), false);
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", startDesignEditor, { once: true });
} else {
  startDesignEditor();
}
