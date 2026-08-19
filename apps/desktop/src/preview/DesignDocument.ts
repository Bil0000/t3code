import type { PreviewAnnotationPayload } from "@t3tools/contracts";

export const DESIGN_UI_ATTRIBUTE = "data-t3code-design-ui";
export const DESIGN_EDITING_ATTRIBUTE = "data-t3code-design-editing";
export const DESIGN_OPEN_ATTRIBUTE = "data-t3code-design-open";

export interface DesignSelectionInput {
  id: string;
  pageUrl: string;
  pageTitle: string | null;
  tagName: string;
  selector: string;
  htmlPreview: string;
  styles: string;
  rect: PreviewAnnotationPayload["elements"][number]["rect"];
  createdAt: string;
}

export function createDesignSelectionAnnotation(
  input: DesignSelectionInput,
): PreviewAnnotationPayload {
  const element = {
    pageUrl: input.pageUrl,
    pageTitle: input.pageTitle,
    tagName: input.tagName,
    selector: input.selector,
    htmlPreview: input.htmlPreview,
    componentName: null,
    source: null,
    stack: [],
    styles: input.styles,
    pickedAt: input.createdAt,
  };
  return {
    id: `design-${input.id}`,
    pageUrl: input.pageUrl,
    pageTitle: input.pageTitle,
    comment: "Selected design element",
    elements: [{ id: input.id, element, rect: input.rect }],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: null,
    createdAt: input.createdAt,
  };
}

const designLength = (value: string | undefined, relativeTo: number): number => {
  const number = Number.parseFloat(value ?? "");
  if (!Number.isFinite(number)) return 0;
  return value?.endsWith("%") ? (number * relativeTo) / 100 : number;
};

export function resolveDesignPosition(
  storedX: string | null,
  storedY: string | null,
  translate: string,
  width: number,
  height: number,
): { x: number; y: number } {
  if (storedX !== null || storedY !== null) {
    return {
      x: designLength(storedX ?? undefined, width),
      y: designLength(storedY ?? undefined, height),
    };
  }
  const [x, y] = translate === "none" ? [] : translate.split(/\s+/);
  return { x: designLength(x, width), y: designLength(y, height) };
}

export function designPathFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const path = parsed.searchParams.get("t3-design-path");
    const segments = path?.split(/[\\/]/) ?? [];
    return parsed.searchParams.has("t3-design") &&
      parsed.pathname.startsWith("/api/assets/") &&
      path !== null &&
      path === path.trim() &&
      path.length > 0 &&
      path.length <= 1024 &&
      segments[0] === ".t3" &&
      segments[1] === "designs" &&
      segments.length > 2 &&
      !path.startsWith("/") &&
      !path.startsWith("\\") &&
      !/^[a-z]:[\\/]/i.test(path) &&
      !segments.includes("..") &&
      /\.html?$/i.test(path)
      ? path
      : null;
  } catch {
    return null;
  }
}

export function serializeDesignDocument(document: Document): string {
  const root = document.documentElement.cloneNode(true) as HTMLElement;
  root.removeAttribute(DESIGN_OPEN_ATTRIBUTE);
  root.querySelectorAll(`[${DESIGN_UI_ATTRIBUTE}]`).forEach((element) => element.remove());
  root.querySelectorAll(`[${DESIGN_EDITING_ATTRIBUTE}]`).forEach((element) => {
    element.removeAttribute(DESIGN_EDITING_ATTRIBUTE);
    element.removeAttribute("contenteditable");
  });
  return `<!doctype html>\n${root.outerHTML}`;
}

export function isDesignDocument(document: Document): boolean {
  return designPathFromUrl(document.location.href) !== null;
}
