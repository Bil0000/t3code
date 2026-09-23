import type { InstalledExtension } from "@t3tools/contracts";

const microsoftPublishers = new Set(["ms-vscode", "ms-python", "ms-toolsai", "ms-dotnettools"]);
const microsoftIds = new Set(["github.copilot", "github.copilot-chat"]);

export function rehAsset(platform: NodeJS.Platform, arch: string): string | null {
  if (!(["linux", "darwin", "win32"] as string[]).includes(platform)) return null;
  if (arch !== "x64" && arch !== "arm64") return null;
  if (platform === "win32" && arch === "arm64") return null;
  return `https://github.com/VSCodium/vscodium/releases/download/1.135.06055/vscodium-reh-${platform}-${arch}-1.135.06055.tar.gz`;
}

export function openVsxUrl(namespace: string, name: string, version?: string): string {
  return `https://open-vsx.org/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}${version ? `/${encodeURIComponent(version)}` : ""}`;
}

export function openVsxDownload(metadata: unknown): { url: string; sha256Url: string } {
  const files = (metadata as { files?: { download?: unknown; sha256?: unknown } })?.files;
  if (typeof files?.download !== "string" || !files.download.startsWith("https://open-vsx.org/")) {
    throw new Error("Open VSX did not provide an HTTPS download URL.");
  }
  if (typeof files.sha256 !== "string" || !files.sha256.startsWith("https://open-vsx.org/")) {
    throw new Error("Open VSX did not provide a SHA-256 URL.");
  }
  return { url: files.download, sha256Url: files.sha256 };
}

export function openVsxSha256(text: string): string {
  const digest = /^[a-f\d]{64}(?=\s|$)/i.exec(text.trim())?.[0];
  if (!digest) throw new Error("Open VSX returned an invalid SHA-256 digest.");
  return digest.toLowerCase();
}

type Manifest = {
  name?: string;
  publisher?: string;
  displayName?: string;
  description?: string;
  version?: string;
  icon?: string;
  extensionKind?: string | string[];
  enabledApiProposals?: string[];
  contributes?: {
    viewsContainers?: Record<string, Array<{ id?: string; title?: string; icon?: string }>>;
    views?: Record<string, Array<{ id?: string; name?: string; type?: string }>>;
    customEditors?: Array<{ viewType?: string; displayName?: string }>;
    commands?: Array<{ command?: string; title?: string; category?: string }>;
  };
};

export function parseInstalledExtension(
  manifest: Manifest,
  nls: Record<string, string>,
  enabled: boolean,
): InstalledExtension | null {
  if (!manifest.publisher || !manifest.name || !manifest.version) return null;
  const id = `${manifest.publisher}.${manifest.name}`;
  if (!/^[a-z0-9][a-z0-9-_.]*\.[a-z0-9][a-z0-9-_]*$/i.test(id)) return null;
  const localize = (value: string | undefined) =>
    value?.replace(/%([^%]+)%/g, (token, key: string) => nls[key] ?? token) ?? "";
  const contributions = manifest.contributes;
  const viewContainers = Object.values(contributions?.viewsContainers ?? {}).flatMap((containers) =>
    containers
      .filter((container) => container.id)
      .map((container) => ({
        id: container.id!,
        title: localize(container.title),
        icon: container.icon
          ? `/api/vscode-icons/${encodeURIComponent(id)}/${encodeURIComponent(container.icon)}`
          : null,
        views: (contributions?.views?.[container.id!] ?? [])
          .filter((view) => view.id)
          .map((view) => ({
            id: view.id!,
            name: localize(view.name),
            type: view.type === "webview" ? ("webview" as const) : ("tree" as const),
          })),
      })),
  );
  const publisher = manifest.publisher;
  const uiOnly =
    manifest.extensionKind === "ui" ||
    (Array.isArray(manifest.extensionKind) &&
      manifest.extensionKind.length > 0 &&
      manifest.extensionKind.every((kind) => kind === "ui"));
  return {
    id: id as InstalledExtension["id"],
    displayName: localize(manifest.displayName) || manifest.name,
    description: localize(manifest.description),
    publisher,
    version: manifest.version as InstalledExtension["version"],
    iconUrl: manifest.icon ? `/api/vscode-icons/${encodeURIComponent(id)}` : null,
    enabled,
    microsoftOnly:
      microsoftPublishers.has(publisher.toLowerCase()) ||
      microsoftIds.has(id.toLowerCase()) ||
      uiOnly,
    viewContainers,
    customEditors: (contributions?.customEditors ?? [])
      .filter((editor) => editor.viewType)
      .map((editor) => ({
        viewType: editor.viewType!,
        displayName: localize(editor.displayName),
      })),
    commands: (contributions?.commands ?? [])
      .filter((command) => command.command)
      .map((command) => ({
        command: command.command!,
        title: localize(command.title),
        category: command.category ? localize(command.category) : null,
      })),
  };
}
