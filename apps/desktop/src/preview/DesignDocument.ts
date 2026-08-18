export const DESIGN_UI_ATTRIBUTE = "data-t3code-design-ui";
export const DESIGN_EDITING_ATTRIBUTE = "data-t3code-design-editing";

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
