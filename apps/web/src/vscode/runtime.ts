import {
  getService,
  ICommandService,
  IEditorService,
  IExtensionService,
  INotificationService,
  IViewsService,
  initialize,
} from "@codingame/monaco-vscode-api";
import getConfigurationServiceOverride, {
  getUserConfiguration,
  updateUserConfiguration,
} from "@codingame/monaco-vscode-configuration-service-override";
import getDialogsServiceOverride from "@codingame/monaco-vscode-dialogs-service-override";
import getNotificationServiceOverride from "@codingame/monaco-vscode-notifications-service-override";
import getQuickAccessServiceOverride from "@codingame/monaco-vscode-quickaccess-service-override";
import getRemoteAgentServiceOverride from "@codingame/monaco-vscode-remote-agent-service-override";
import getSearchServiceOverride from "@codingame/monaco-vscode-search-service-override";
import getStorageServiceOverride from "@codingame/monaco-vscode-storage-service-override";
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override";
import "@codingame/monaco-vscode-theme-defaults-default-extension";
import { ISplashStorageService } from "@codingame/monaco-vscode-view-common-service-override/vscode/vs/workbench/contrib/splash/browser/splash.service";
import getViewsServiceOverride, {
  attachPart,
  Parts,
} from "@codingame/monaco-vscode-views-service-override";
import { IRemoteAuthorityResolverService } from "@codingame/monaco-vscode-api/vscode/vs/platform/remote/common/remoteAuthorityResolver.service";
import {
  InstantiationType,
  registerSingleton,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/extensions";
import {
  NotificationChangeType,
  NotificationViewItemContentChangeKind,
  type INotificationViewItem,
} from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/notifications";
import { WebviewInput } from "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/webviewPanel/browser/webviewEditorInput";
import { ITextModelService } from "@codingame/monaco-vscode-api/vscode/vs/editor/common/services/resolverService.service";
import { ITextFileService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/textfile/common/textfiles.service";
import * as monaco from "monaco-editor";
import { formatHex } from "culori";
import { applyEdits, modify } from "jsonc-parser";

import { toastManager } from "~/components/ui/toast";
import type { ExtensionHostConnection } from "@t3tools/contracts";

export { attachPart, Parts };

class SplashStorageService {
  readonly _serviceBrand: undefined = undefined;
  async saveWindowSplash() {}
}

registerSingleton(ISplashStorageService, SplashStorageService, InstantiationType.Delayed);

let runtime: Promise<Awaited<ReturnType<typeof startRuntime>>> | null = null;
let runtimeKey: string | null = null;
let editorRoot: HTMLElement | null = null;
let editorAttachment: ReturnType<typeof attachPart> | null = null;
let workbenchRoot: HTMLElement | null = null;
let initialized = false;
let modelReferencePatched = false;
let disposeWebviewPositioning: (() => void) | null = null;

function attachEditor(container: HTMLElement) {
  editorAttachment?.dispose();
  editorAttachment = attachPart(Parts.EDITOR_PART, container);
}

export function showEditor(container: HTMLElement) {
  attachEditor(container);
}

export function parkEditor() {
  if (editorRoot) attachEditor(editorRoot);
}

function positionWebviews(root: HTMLElement) {
  const anchors = [...document.querySelectorAll<HTMLElement>("[style*='anchor-name']")];
  const observer = new ResizeObserver(update);
  const observed = new Set<HTMLElement>();
  function update() {
    for (const overlay of root.querySelectorAll<HTMLElement>(".webview-overlay-content")) {
      const name = overlay.style.getPropertyValue("position-anchor");
      const anchor = anchors.find(
        (element) => element.style.getPropertyValue("anchor-name") === name,
      );
      if (!anchor) continue;
      const editorPart = anchor.closest(".part.editor");
      const target = editorPart ? editorPart.closest<HTMLElement>(".t3-vscode-part") : anchor;
      if (target && !observed.has(target)) {
        observed.add(target);
        observer.observe(target);
      }
      const rect = target?.getBoundingClientRect();
      overlay.style.setProperty("top", `${rect?.top ?? 0}px`, "important");
      overlay.style.setProperty("left", `${rect?.left ?? 0}px`, "important");
      overlay.style.setProperty("width", `${rect?.width ?? 0}px`, "important");
      overlay.style.setProperty("height", `${rect?.height ?? 0}px`, "important");
    }
  }
  const mutations = new MutationObserver(() => {
    for (const anchor of document.querySelectorAll<HTMLElement>("[style*='anchor-name']")) {
      if (!anchors.includes(anchor)) anchors.push(anchor);
    }
    update();
  });
  mutations.observe(root, { childList: true, subtree: true });
  window.addEventListener("resize", update);
  document.addEventListener("scroll", update, true);
  update();
  return () => {
    mutations.disconnect();
    observer.disconnect();
    window.removeEventListener("resize", update);
    document.removeEventListener("scroll", update, true);
  };
}

async function startRuntime(
  connection: ExtensionHostConnection,
  httpBaseUrl: string,
  workspaceRoot?: string,
) {
  const url = new URL(httpBaseUrl);
  const remoteAuthority = url.host;
  if (!workbenchRoot) {
    workbenchRoot = document.createElement("div");
    workbenchRoot.className = "t3-vscode-root";
    document.body.append(workbenchRoot);
    disposeWebviewPositioning = positionWebviews(workbenchRoot);
  }
  const root = workbenchRoot;
  try {
    if (!initialized) {
      await initialize(
        {
          ...getConfigurationServiceOverride(),
          ...getStorageServiceOverride(),
          ...getSearchServiceOverride(),
          ...getNotificationServiceOverride(),
          ...getDialogsServiceOverride(),
          ...getThemeServiceOverride(),
          ...getQuickAccessServiceOverride(),
          ...getRemoteAgentServiceOverride({ scanRemoteExtensions: true }),
          ...getViewsServiceOverride(),
        },
        root,
        {
          remoteAuthority,
          serverBasePath: connection.basePath,
          connectionToken: connection.connectionToken,
          workspaceProvider: {
            trusted: true,
            workspace: workspaceRoot
              ? {
                  folderUri: monaco.Uri.from({
                    scheme: "vscode-remote",
                    authority: remoteAuthority,
                    path: workspaceRoot,
                  }),
                }
              : undefined,
            async open() {
              return false;
            },
          },
          productConfiguration: { quality: connection.quality, commit: connection.commit },
        },
      );
      initialized = true;
    }
    editorRoot = root;
    parkEditor();
    const models = await getService(ITextModelService);
    const files = await getService(ITextFileService);
    if (!modelReferencePatched) {
      const createModelReference = models.createModelReference.bind(models);
      models.createModelReference = async (resource) => {
        if (resource.scheme === "vscode-remote" && !monaco.editor.getModel(resource)) {
          await files.files.resolve(resource);
        }
        return createModelReference(resource);
      };
      modelReferencePatched = true;
    }
    const views = await getService(IViewsService);
    await (await getService(IExtensionService)).whenInstalledExtensionsRegistered();
    const commands = await getService(ICommandService);
    const editors = await getService(IEditorService);
    const notification = (await getService(INotificationService)) as unknown as {
      model: import("@codingame/monaco-vscode-api/vscode/vs/workbench/common/notifications").NotificationsModel;
    };
    const showNotification = (item: INotificationViewItem) => {
      if (item.hasProgress && !item.progress.state.done) return;
      const type = item.severity === 3 ? "error" : item.severity === 2 ? "warning" : "info";
      const actions = [...(item.actions?.primary ?? []), ...(item.actions?.secondary ?? [])];
      let toastId: ReturnType<typeof toastManager.add>;
      const runAction = (action: (typeof actions)[number]) => {
        void action.run();
        toastManager.close(toastId);
      };
      toastId = toastManager.add({
        type,
        title: item.message.raw,
        ...(actions[0]
          ? { actionProps: { children: actions[0].label, onClick: () => runAction(actions[0]!) } }
          : {}),
        data: {
          actionLayout: "stacked-end",
          additionalActions: actions.slice(1).map((action) => ({
            id: action.id,
            props: {
              children: action.label,
              onClick: () => runAction(action),
            },
          })),
        },
      });
      item.close();
    };
    notification.model.onDidChangeNotification((event) => {
      if (
        event.kind === NotificationChangeType.ADD ||
        (event.kind === NotificationChangeType.CHANGE &&
          event.detail === NotificationViewItemContentChangeKind.PROGRESS &&
          event.item.progress.state.done)
      )
        showNotification(event.item);
    });
    for (const item of notification.model.notifications) showNotification(item);
    return { views, commands, editors, remoteAuthority };
  } catch (error) {
    if (!initialized) {
      disposeWebviewPositioning?.();
      disposeWebviewPositioning = null;
      root.remove();
      workbenchRoot = null;
    }
    throw error;
  }
}

export async function getRuntime(
  connection: ExtensionHostConnection,
  httpBaseUrl: string,
  workspaceRoot?: string,
) {
  const key = `${httpBaseUrl}|${connection.commit}|${workspaceRoot ?? ""}`;
  if (initialized && runtimeKey !== key)
    throw new Error(
      "Extensions are running for another project. Reload the page to use them here.",
    );
  if (!runtime) {
    runtimeKey = key;
    runtime = startRuntime(connection, httpBaseUrl, workspaceRoot).catch((error: unknown) => {
      runtime = null;
      throw error;
    });
  }
  if (runtimeKey !== key)
    throw new Error(
      "Extensions are running for another project. Reload the page to use them here.",
    );
  const current = await runtime;
  const resolver = await getService(IRemoteAuthorityResolverService);
  resolver._setAuthorityConnectionToken(current.remoteAuthority, connection.connectionToken);
  return current;
}

export async function runExtensionCommand(command: string) {
  if (!runtime) throw new Error("Open an extension panel first.");
  return (await runtime).commands.executeCommand(command);
}

export async function activeWebview(extensionId: string) {
  if (!runtime) return null;
  const editor = (await runtime).editors.activeEditor;
  if (!(editor instanceof WebviewInput)) return null;
  if (editor.extension && editor.extension.id.value.toLowerCase() !== extensionId.toLowerCase())
    return null;
  return {
    kind: "extension-webview" as const,
    extensionId,
    viewType: editor.viewType,
    title: editor.getName(),
    resource: editor.resource.toString(),
  };
}

export async function showWebview(extensionId: string, viewType: string, resource?: string) {
  if (!runtime) return false;
  const editors = (await runtime).editors;
  const input = editors.editors.find(
    (editor) =>
      editor instanceof WebviewInput &&
      editor.viewType === viewType &&
      (resource === undefined || editor.resource.toString() === resource) &&
      editor.extension?.id.value.toLowerCase() === extensionId.toLowerCase(),
  );
  if (!input) return false;
  await editors.openEditor(input);
  return true;
}

export async function syncTheme(element: HTMLElement) {
  const styles = getComputedStyle(element);
  const background = formatHex(styles.getPropertyValue("--background").trim());
  const foreground = formatHex(styles.getPropertyValue("--foreground").trim());
  const border = formatHex(styles.getPropertyValue("--border").trim());
  const muted = formatHex(styles.getPropertyValue("--muted").trim());
  if (!background || !foreground || !border || !muted) return;
  const colors = {
    "sideBar.background": background,
    "editor.background": background,
    "panel.background": background,
    "sideBar.foreground": foreground,
    "editor.foreground": foreground,
    "input.background": muted,
    "sideBar.border": border,
    "editorGroup.border": border,
  };
  let configuration = await getUserConfiguration();
  const settings: Array<[string[], string | boolean]> = [
    [["workbench.editor.enablePreview"], false],
    [
      ["workbench.colorTheme"],
      document.documentElement.classList.contains("dark")
        ? "Default Dark Modern"
        : "Default Light Modern",
    ],
    ...Object.entries(colors).map(([key, value]): [string[], string] => [
      ["workbench.colorCustomizations", key],
      value,
    ]),
  ];
  for (const [path, value] of settings) {
    configuration = applyEdits(
      configuration,
      modify(configuration, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
    );
  }
  await updateUserConfiguration(configuration);
}
