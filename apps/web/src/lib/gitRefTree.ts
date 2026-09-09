import type { VcsHistoryRef } from "@t3tools/contracts";

export type GitRefTreeNode =
  | {
      readonly kind: "folder";
      readonly name: string;
      readonly path: string;
      readonly children: ReadonlyArray<GitRefTreeNode>;
    }
  | {
      readonly kind: "ref";
      readonly name: string;
      readonly ref: VcsHistoryRef;
    };

interface MutableFolder {
  readonly folders: Map<string, MutableFolder>;
  readonly refs: VcsHistoryRef[];
}

function createFolder(): MutableFolder {
  return { folders: new Map(), refs: [] };
}

function compareRefs(left: VcsHistoryRef, right: VcsHistoryRef): number {
  if (left.current !== right.current) return left.current ? -1 : 1;
  if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
  return left.name.localeCompare(right.name);
}

function materialize(folder: MutableFolder, parentPath: string): GitRefTreeNode[] {
  const folders = [...folder.folders.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, child]) => {
      const path = parentPath.length === 0 ? name : `${parentPath}/${name}`;
      return {
        kind: "folder" as const,
        name,
        path,
        children: materialize(child, path),
      };
    });
  const refs = folder.refs.sort(compareRefs).map((ref) => ({
    kind: "ref" as const,
    name: ref.name.split("/").at(-1) ?? ref.name,
    ref,
  }));
  const pinned = refs.filter((node) => node.ref.current || node.ref.isDefault);
  const ordinary = refs.filter((node) => !node.ref.current && !node.ref.isDefault);
  return [...pinned, ...folders, ...ordinary];
}

export function buildGitRefTree(refs: ReadonlyArray<VcsHistoryRef>): ReadonlyArray<GitRefTreeNode> {
  const root = createFolder();
  for (const ref of refs) {
    const segments = ref.name.split("/").filter((segment) => segment.length > 0);
    let folder = root;
    for (const segment of segments.slice(0, -1)) {
      const child = folder.folders.get(segment) ?? createFolder();
      folder.folders.set(segment, child);
      folder = child;
    }
    folder.refs.push(ref);
  }
  return materialize(root, "");
}

export function filterGitRefTree(
  nodes: ReadonlyArray<GitRefTreeNode>,
  query: string,
): ReadonlyArray<GitRefTreeNode> {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return nodes;
  const filtered: GitRefTreeNode[] = [];
  for (const node of nodes) {
    if (node.kind === "ref") {
      if (node.ref.name.toLocaleLowerCase().includes(normalized)) filtered.push(node);
      continue;
    }
    if (node.path.toLocaleLowerCase().includes(normalized)) {
      filtered.push(node);
      continue;
    }
    const children = filterGitRefTree(node.children, normalized);
    if (children.length > 0) filtered.push({ ...node, children });
  }
  return filtered;
}
