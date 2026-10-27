import { act } from "react";
import { createRoot } from "react-dom/client";
import * as NodeModule from "node:module";
import { expect, it, vi } from "vite-plus/test";

const { JSDOM } = NodeModule.createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string) => { window: { document: Document; close(): void } };
};

const state = vi.hoisted(() => ({
  project: { environmentId: "env", id: "project", title: "Project", workspaceRoot: "/repo" },
  share: { id: "share", text: "Shared text", attachments: [], warnings: [] },
  goBack: vi.fn(),
  alert: vi.fn(),
  reserve: vi.fn(),
  consume: vi.fn(),
  merge: vi.fn(),
  setTemporary: vi.fn(),
  preventRemove: false,
  draft: { text: "Private text", attachments: [], temporary: true },
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, Pressable: () => null, View: "div" }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({}) }));
vi.mock("@react-navigation/native", () => ({
  CommonActions: { navigate: vi.fn() },
  StackActions: { replace: vi.fn() },
  useNavigation: () => ({ goBack: state.goBack, dispatch: vi.fn() }),
  useIsFocused: () => true,
  usePreventRemove: (prevent: boolean) => {
    state.preventRemove = prevent;
  },
}));
vi.mock("react-native-keyboard-controller", () => ({ KeyboardController: {} }));
vi.mock("../../state/use-temporary-thread-views", () => ({ enqueueTemporaryDraftThread: vi.fn() }));
vi.mock("./DraftEnvironmentControl", () => ({ DraftEnvironmentControl: () => null }));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollEdgeEffectsContext: "div" }));
vi.mock("./DraftThreadHeader", () => ({ DraftThreadHeader: () => null }));
vi.mock("./useRememberThreadProject", () => ({ useRememberThreadProject: () => {} }));
vi.mock("./thread-header-appearance", () => ({ threadHeaderAppearance: () => ({}) }));
vi.mock("../../native/native-glass", () => ({ NATIVE_LIQUID_GLASS_SUPPORTED: false }));
vi.mock("../../state/use-composer-attachment-actions", () => ({
  useComposerAttachmentActions: () => ({}),
}));
vi.mock("../workspace/useAndroidWorkspaceNavigation", () => ({
  useWorkspaceBackNavigation: () => state.goBack,
}));
vi.mock("./ThreadScreenHost", () => ({
  ThreadScreenBinding: () => null,
  ThreadScreenFallback: "div",
}));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: state.alert }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: "div" }));
vi.mock("../../components/ComposerEditor", () => ({ ComposerEditor: () => null }));
vi.mock("../../components/ComposerToolbar", () => ({ ComposerInlineControl: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: "span" }));
vi.mock("../../lib/commandMetadata", () => ({ makeTurnCommandMetadata: () => ({}) }));
vi.mock("../../state/use-composer-drafts", () => ({
  composerContextImportsAtom: {},
  getComposerDraftSnapshot: () => state.draft,
  mergeComposerDraftContent: state.merge,
  clearComposerDraftContent: vi.fn(),
  restoreComposerDraftSnapshot: vi.fn(),
  updateComposerDraftSettings: vi.fn(),
  scheduleUnusedComposerAttachmentCleanup: vi.fn(),
  waitForComposerDraftsLoaded: async () => {},
}));
vi.mock("../../state/composer-attachment-uploads", () => ({
  composerAttachmentUploadsAtom: {},
  composerAttachmentUploadBlockReason: () => null,
  composerAttachmentsStillUploading: () => false,
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [state.project],
  useEnvironmentServerConfig: () => null,
}));
vi.mock("../../state/projectClones", () => ({ useProjectClone: () => null }));
vi.mock("../../state/projects", () => ({ projectEnvironment: {} }));
vi.mock("../../state/sourceControl", () => ({ sourceControlEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./ProjectCloneBanner", () => ({ ProjectCloneBanner: () => null }));
vi.mock("../../state/thread-outbox", () => ({ enqueueThreadOutboxMessage: vi.fn() }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnections: () => ({}),
  useRemoteEnvironmentRuntime: () => null,
}));
vi.mock("./new-task-flow-provider", () => ({
  useNewTaskFlow: () => ({
    selectedProject: state.project,
    selectedProjectKey: "env:project",
    projectScopes: [],
    environments: [],
    draftKey: "draft",
    temporary: true,
    submitting: false,
    setTemporary: state.setTemporary,
    prompt: state.draft.text,
    attachments: [],
    availableBranches: [],
    editingPendingTask: null,
    selectedModel: null,
    workspaceMode: "local",
    loadBranches: vi.fn(),
  }),
}));
vi.mock("../keyboard/hardwareKeyboardCommands", () => ({
  useHardwareKeyboardCommand: () => {},
  nextEnvironmentId: () => null,
}));
vi.mock("../sharing/IncomingShareProvider", () => ({
  useIncomingShare: () => ({
    getShare: () => state.share,
    reserveShare: state.reserve,
    consumeShare: state.consume,
    releaseShareReservation: vi.fn(),
    isLoading: false,
  }),
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { get: () => ({}) } }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));

import { NewTaskDraftScreen } from "./NewTaskDraftScreen";

it("cancels a share handoff into a private draft without saving or importing its content", async () => {
  const dom = new JSDOM("<html><body></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<NewTaskDraftScreen incomingShareId="share" />));
    expect(state.preventRemove).toBe(false);
    expect(state.goBack).toHaveBeenCalledOnce();
    expect(state.alert).toHaveBeenCalledOnce();
    expect(state.setTemporary).not.toHaveBeenCalled();
    expect(state.reserve).not.toHaveBeenCalled();
    expect(state.consume).not.toHaveBeenCalled();
    expect(state.merge).not.toHaveBeenCalled();
    expect(state.draft).toEqual({ text: "Private text", attachments: [], temporary: true });
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    dom.window.close();
  }
});
