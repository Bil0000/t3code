import {
  FILL_PREVIEW_VIEWPORT,
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationPressInput,
  PreviewAutomationResizeInput,
  type PreviewAutomationSnapshot,
  PreviewAutomationScrollInput,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
  PreviewServerBrowserError,
  type PreviewCloseInput,
  type PreviewNavigateInput,
  type PreviewOpenInput,
  type PreviewRefreshInput,
  type PreviewResizeInput,
  type PreviewServerBrowserFrame,
  type PreviewServerBrowserInput,
  type PreviewServerBrowserInstallation,
  type PreviewSessionSnapshot,
  type PreviewViewportSetting,
  type ThreadId,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import { PREVIEW_PAGE_SNAPSHOT_SCRIPT } from "@t3tools/shared/previewPageSnapshot";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { Browser, BrowserContext, Page } from "playwright-core";

import type { PreviewAutomationInvokeInput } from "../mcp/PreviewAutomationBroker.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as BrowserEngine from "./BrowserEngine.ts";
import * as PreviewManager from "./Manager.ts";

const isServerBrowserError = Schema.is(PreviewServerBrowserError);
const decodeOpen = Schema.decodeUnknownEffect(PreviewAutomationOpenInput);
const decodeNavigate = Schema.decodeUnknownEffect(PreviewAutomationNavigateInput);
const decodeResize = Schema.decodeUnknownEffect(PreviewAutomationResizeInput);
const decodeClick = Schema.decodeUnknownSync(PreviewAutomationClickInput);
const decodeType = Schema.decodeUnknownSync(PreviewAutomationTypeInput);
const decodePress = Schema.decodeUnknownSync(PreviewAutomationPressInput);
const decodeScroll = Schema.decodeUnknownSync(PreviewAutomationScrollInput);
const decodeEvaluate = Schema.decodeUnknownSync(PreviewAutomationEvaluateInput);
const decodeWaitFor = Schema.decodeUnknownSync(PreviewAutomationWaitForInput);
const decodeSetColorScheme = Schema.decodeUnknownSync(PreviewAutomationSetColorSchemeInput);

const failure = (cause: unknown) =>
  isServerBrowserError(cause)
    ? cause
    : new PreviewServerBrowserError({
        stage: "action",
        reason: "failed",
        cause,
      });
const promise = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failure });
const size = (viewport: PreviewViewportSetting) =>
  viewport._tag === "fill"
    ? { width: 1280, height: 800 }
    : { width: viewport.width, height: viewport.height };
const key = (threadId: string, tabId: string) => `${threadId}\u0000${tabId}`;

export class ServerBrowser extends Context.Service<
  ServerBrowser,
  {
    readonly install: Effect.Effect<void, PreviewServerBrowserError>;
    readonly installation: Stream.Stream<PreviewServerBrowserInstallation>;
    readonly open: (
      input: PreviewOpenInput,
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewServerBrowserError>;
    readonly navigate: (
      input: PreviewNavigateInput,
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewServerBrowserError>;
    readonly resize: (
      input: PreviewResizeInput,
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewServerBrowserError>;
    readonly refresh: (
      input: PreviewRefreshInput,
    ) => Effect.Effect<void, PreviewServerBrowserError>;
    readonly close: (input: PreviewCloseInput) => Effect.Effect<void, PreviewServerBrowserError>;
    readonly control: (
      input: PreviewServerBrowserInput,
    ) => Effect.Effect<void, PreviewServerBrowserError>;
    readonly watch: (
      input: PreviewRefreshInput,
    ) => Stream.Stream<PreviewServerBrowserFrame, PreviewServerBrowserError>;
    readonly invoke: (
      input: PreviewAutomationInvokeInput,
    ) => Effect.Effect<unknown, PreviewServerBrowserError>;
  }
>()("t3/preview/ServerBrowser") {}

export const make = Effect.gen(function* () {
  const engine = yield* BrowserEngine.BrowserEngine;
  const manager = yield* PreviewManager.PreviewManager;
  const serverScope = yield* Scope.Scope;
  const services = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(services);
  const startup = yield* Semaphore.make(1);
  const contexts = new Map<ThreadId, BrowserContext>();
  const pages = new Map<
    string,
    {
      page: Page;
      lock: Semaphore.Semaphore;
      frames: Stream.Stream<PreviewServerBrowserFrame, PreviewServerBrowserError>;
    }
  >();
  let currentTabs = new WeakMap<McpInvocationScope, string>();
  const diagnostics = new Map<
    string,
    Pick<PreviewAutomationSnapshot, "consoleEntries" | "networkEntries">
  >();
  let browser: Browser | undefined;

  const getBrowser = startup.withPermit(
    Effect.gen(function* () {
      if (!browser?.isConnected()) {
        for (const threadId of contexts.keys()) {
          const listed = yield* manager.list({ threadId });
          for (const tab of listed.sessions)
            if (tab.runtime === "server")
              yield* manager.close({ threadId, tabId: tab.tabId }).pipe(Effect.mapError(failure));
        }
        contexts.clear();
        pages.clear();
        currentTabs = new WeakMap();
        diagnostics.clear();
        browser = yield* Effect.acquireRelease(engine.launch, (owned) =>
          promise(() => owned.close()).pipe(Effect.ignore),
        ).pipe(Effect.provideService(Scope.Scope, serverScope));
      }
      return browser;
    }),
  );
  const find = (input: PreviewRefreshInput) =>
    Effect.try({
      try: () => {
        const tab = pages.get(key(input.threadId, input.tabId));
        if (!tab || tab.page.isClosed())
          throw new Error("The server browser tab is closed. Open a new browser tab.");
        return tab;
      },
      catch: failure,
    });
  const report = (threadId: ThreadId, tabId: string, page: Page) =>
    promise(async () => {
      const title = (await page.title()).slice(0, 512);
      const cdp = await page.context().newCDPSession(page);
      try {
        const history = await cdp.send("Page.getNavigationHistory");
        return {
          url: page.url(),
          title,
          canGoBack: history.currentIndex > 0,
          canGoForward: history.currentIndex < history.entries.length - 1,
        };
      } finally {
        await cdp.detach();
      }
    }).pipe(
      Effect.flatMap(({ url, title, canGoBack, canGoForward }) =>
        manager.reportStatus({
          threadId,
          tabId,
          navStatus: { _tag: "Success", url, title },
          canGoBack,
          canGoForward,
        }),
      ),
      Effect.mapError(failure),
    );
  const snapshot = (threadId: ThreadId, tabId: string) =>
    manager.list({ threadId }).pipe(
      Effect.flatMap((result) => {
        const tab = result.sessions.find((session) => session.tabId === tabId);
        return tab
          ? Effect.succeed(tab)
          : Effect.fail(new PreviewServerBrowserError({ stage: "action", reason: "closed" }));
      }),
    );
  const status = (threadId: ThreadId, tabId?: string) =>
    Effect.gen(function* () {
      const tab = tabId ? pages.get(key(threadId, tabId)) : undefined;
      if (!tab || tab.page.isClosed())
        return {
          available: true,
          visible: false,
          tabId: null,
          url: null,
          title: null,
          loading: false,
        };
      return {
        available: true,
        visible: false,
        tabId,
        url: tab.page.url(),
        title: yield* promise(() => tab.page.title()),
        loading: false,
        viewport: tab.page.viewportSize(),
      };
    });
  const navigate = Effect.fn("ServerBrowser.navigate")(function* (
    input: PreviewNavigateInput,
    options: Parameters<Page["goto"]>[1] = {},
  ) {
    const tab = yield* find(input);
    const url = yield* Effect.try({ try: () => normalizePreviewUrl(input.url), catch: failure });
    yield* manager
      .reportStatus({
        ...input,
        navStatus: { _tag: "Loading", url, title: "" },
        canGoBack: false,
        canGoForward: false,
      })
      .pipe(Effect.mapError(failure));
    yield* tab.lock.withPermit(
      promise(() =>
        tab.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000, ...options }),
      ).pipe(
        Effect.catch((cause) =>
          manager
            .reportStatus({
              ...input,
              navStatus: {
                _tag: "LoadFailed",
                url,
                title: "",
                code: -2,
                description: cause.message,
              },
              canGoBack: false,
              canGoForward: false,
            })
            .pipe(Effect.mapError(failure), Effect.andThen(Effect.fail(cause))),
        ),
      ),
    );
    yield* report(input.threadId, input.tabId, tab.page);
    return yield* snapshot(input.threadId, input.tabId);
  });
  const open = Effect.fn("ServerBrowser.open")(function* (input: PreviewOpenInput) {
    const owned = yield* getBrowser;
    const state = yield* startup.withPermit(
      Effect.gen(function* () {
        let existing = contexts.get(input.threadId);
        if (!existing) {
          existing = yield* promise(() =>
            owned.newContext({ viewport: size(input.viewport ?? FILL_PREVIEW_VIEWPORT) }),
          );
          contexts.set(input.threadId, existing);
        }
        const page = yield* promise(() => existing.newPage());
        const entries = {
          consoleEntries: [] as Array<PreviewAutomationSnapshot["consoleEntries"][number]>,
          networkEntries: [] as Array<PreviewAutomationSnapshot["networkEntries"][number]>,
        };
        const timestamp = () => DateTime.formatIso(DateTime.nowUnsafe());
        page.on("console", (message) => {
          entries.consoleEntries.push({
            level: message.type(),
            text: message.text().slice(0, 2000),
            timestamp: timestamp(),
          });
          entries.consoleEntries.splice(0, Math.max(0, entries.consoleEntries.length - 100));
        });
        page.on("pageerror", (error) => {
          entries.consoleEntries.push({
            level: "error",
            text: error.message.slice(0, 2000),
            timestamp: timestamp(),
          });
          entries.consoleEntries.splice(0, Math.max(0, entries.consoleEntries.length - 100));
        });
        page.on("response", (response) => {
          entries.networkEntries.push({
            url: response.url().slice(0, 2048),
            method: response.request().method(),
            status: response.status(),
            failed: false,
            timestamp: timestamp(),
          });
          entries.networkEntries.splice(0, Math.max(0, entries.networkEntries.length - 100));
        });
        page.on("requestfailed", (request) => {
          entries.networkEntries.push({
            url: request.url().slice(0, 2048),
            method: request.method(),
            status: null,
            failed: true,
            ...(request.failure() ? { errorText: request.failure()!.errorText } : {}),
            timestamp: timestamp(),
          });
          entries.networkEntries.splice(0, Math.max(0, entries.networkEntries.length - 100));
        });
        yield* promise(() => page.setViewportSize(size(input.viewport ?? FILL_PREVIEW_VIEWPORT)));
        const state = yield* manager
          .open({ ...input, url: undefined, runtime: "server" })
          .pipe(Effect.mapError(failure));
        const frames = yield* Stream.share(createFrames(page), {
          capacity: 1,
          strategy: "sliding",
          replay: 1,
        }).pipe(Effect.provideService(Scope.Scope, serverScope));
        pages.set(key(input.threadId, state.tabId), {
          page,
          lock: yield* Semaphore.make(1),
          frames,
        });
        diagnostics.set(key(input.threadId, state.tabId), entries);
        page.on("domcontentloaded", () => {
          runFork(report(input.threadId, state.tabId, page).pipe(Effect.ignore));
        });
        return state;
      }),
    );
    return input.url
      ? yield* navigate({ threadId: input.threadId, tabId: state.tabId, url: input.url })
      : state;
  });
  const resize = Effect.fn("ServerBrowser.resize")(function* (input: PreviewResizeInput) {
    const tab = yield* find(input);
    yield* tab.lock.withPermit(promise(() => tab.page.setViewportSize(size(input.viewport))));
    return yield* manager.resize(input).pipe(Effect.mapError(failure));
  });
  const refresh = Effect.fn("ServerBrowser.refresh")(function* (input: PreviewRefreshInput) {
    const tab = yield* find(input);
    yield* tab.lock.withPermit(promise(() => tab.page.reload({ waitUntil: "domcontentloaded" })));
    yield* report(input.threadId, input.tabId, tab.page);
  });
  const close = (input: PreviewCloseInput) =>
    startup.withPermit(
      Effect.gen(function* () {
        for (const [id, tab] of pages) {
          if (
            !id.startsWith(`${input.threadId}\u0000`) ||
            (input.tabId && id !== key(input.threadId, input.tabId))
          )
            continue;
          pages.delete(id);
          diagnostics.delete(id);
          yield* promise(() => tab.page.close()).pipe(Effect.ignore);
        }
        if (![...pages.keys()].some((id) => id.startsWith(`${input.threadId}\u0000`))) {
          const context = contexts.get(input.threadId);
          contexts.delete(input.threadId);
          if (context) yield* promise(() => context.close()).pipe(Effect.ignore);
        }
        yield* manager.close(input).pipe(Effect.mapError(failure));
      }),
    );
  const control = Effect.fn("ServerBrowser.control")(function* (input: PreviewServerBrowserInput) {
    const tab = yield* find(input);
    const { page } = tab;
    yield* tab.lock.withPermit(
      promise(async () => {
        const action = input.action;
        switch (action._tag) {
          case "back":
            await page.goBack();
            break;
          case "forward":
            await page.goForward();
            break;
          case "click":
            await page.mouse.click(action.x, action.y);
            break;
          case "press":
            await page.keyboard.press(action.key);
            break;
          case "type":
            await page.keyboard.insertText(action.text);
            break;
          case "scroll":
            await page.mouse.wheel(action.deltaX, action.deltaY);
            break;
        }
      }),
    );
    yield* report(input.threadId, input.tabId, page);
  });
  const createFrames = (page: Page) =>
    Stream.callback<PreviewServerBrowserFrame, PreviewServerBrowserError>(
      (queue) =>
        Effect.gen(function* () {
          const viewerScope = yield* Scope.Scope;
          const cdp = yield* Effect.acquireRelease(
            promise(() => page.context().newCDPSession(page)),
            (session) =>
              promise(async () => {
                await session.send("Page.stopScreencast").catch(() => undefined);
                await session.detach();
              }).pipe(Effect.ignore),
          );
          cdp.on("Page.screencastFrame", (frame) => {
            const viewport = page.viewportSize() ?? size(FILL_PREVIEW_VIEWPORT);
            runFork(
              Queue.offer(queue, { data: frame.data, ...viewport }).pipe(
                Effect.andThen(Effect.sleep("100 millis")),
                Effect.andThen(
                  promise(() =>
                    cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }),
                  ),
                ),
                Effect.ignore,
                Effect.forkIn(viewerScope),
              ),
            );
          });
          yield* promise(() =>
            cdp.send("Page.startScreencast", {
              format: "jpeg",
              quality: 60,
              maxWidth: 1280,
              maxHeight: 800,
              everyNthFrame: 1,
            }),
          );
        }),
      { bufferSize: 1, strategy: "sliding" },
    );

  const watch = (input: PreviewRefreshInput) =>
    Stream.unwrap(find(input).pipe(Effect.map((tab) => tab.frames)));

  const invoke = Effect.fn("ServerBrowser.invoke")(function* (
    request: PreviewAutomationInvokeInput,
  ) {
    const threadId = request.scope.threadId;
    const listed = yield* manager.list({ threadId });
    const assigned = currentTabs.get(request.scope);
    let tabId =
      request.tabId ??
      (assigned && pages.has(key(threadId, assigned)) ? assigned : undefined) ??
      listed.sessions.find((session) => session.runtime === "server")?.tabId;
    if (request.operation === "status") return yield* status(threadId, tabId);
    if (request.operation === "open") {
      const input = yield* decodeOpen(request.input).pipe(Effect.mapError(failure));
      if (!tabId || !pages.has(key(threadId, tabId)) || input.reuseExistingTab === false) {
        tabId = (yield* open({ threadId, ...(input.url ? { url: input.url } : {}) })).tabId;
      } else if (input.url) {
        yield* navigate({ threadId, tabId, url: input.url });
      }
      currentTabs.set(request.scope, tabId);
      request.onTargetTab?.(tabId);
      return yield* status(threadId, tabId);
    }
    if (!tabId)
      return yield* new PreviewServerBrowserError({
        stage: "action",
        reason: "unopened",
      });
    const target = { threadId, tabId };
    const tab = yield* find(target);
    request.onTargetTab?.(tabId);
    if (request.updateCurrentTab !== false) currentTabs.set(request.scope, tabId);
    if (request.operation === "navigate") {
      const input = yield* decodeNavigate(request.input).pipe(Effect.mapError(failure));
      const url =
        input.target?.kind === "environment-port"
          ? `${input.target.protocol ?? "http"}://localhost:${input.target.port}${input.target.path?.startsWith("/") ? input.target.path : `/${input.target.path ?? ""}`}`
          : input.target?.kind === "url"
            ? input.target.url
            : input.url!;
      yield* navigate(
        { ...target, url },
        {
          waitUntil:
            input.readiness === "none"
              ? "commit"
              : input.readiness === "domContentLoaded"
                ? "domcontentloaded"
                : "load",
          timeout: input.timeoutMs ?? request.timeoutMs ?? 15000,
        },
      );
      return yield* status(threadId, tabId);
    }
    if (request.operation === "resize") {
      const input = yield* decodeResize(request.input).pipe(Effect.mapError(failure));
      const viewport = resolvePreviewViewport(input);
      yield* resize({ ...target, viewport });
      return { tabId, setting: viewport, viewport: size(viewport) };
    }
    const result = yield* tab.lock.withPermit(
      promise(async () => {
        const { page } = tab;
        const timeout = request.timeoutMs ?? 15000;
        switch (request.operation) {
          case "snapshot": {
            const details = await page.evaluate<
              Pick<
                PreviewAutomationSnapshot,
                "url" | "title" | "loading" | "visibleText" | "interactiveElements"
              >
            >(PREVIEW_PAGE_SNAPSHOT_SCRIPT);
            const viewport = page.viewportSize() ?? size(FILL_PREVIEW_VIEWPORT);
            const scale = Math.min(1, 1280 / viewport.width);
            const cdp = await page.context().newCDPSession(page);
            let screenshot: string;
            try {
              screenshot = (
                await cdp.send("Page.captureScreenshot", {
                  format: "png",
                  clip: { x: 0, y: 0, ...viewport, scale },
                })
              ).data;
            } finally {
              await cdp.detach();
            }
            return {
              ...details,
              accessibilityTree: await page.locator("body").ariaSnapshot(),
              consoleEntries: diagnostics.get(key(threadId, tabId!))?.consoleEntries ?? [],
              networkEntries: diagnostics.get(key(threadId, tabId!))?.networkEntries ?? [],
              actionTimeline: [],
              screenshot: {
                mimeType: "image/png",
                data: screenshot,
                width: Math.round(viewport.width * scale),
                height: Math.round(viewport.height * scale),
              },
            };
          }
          case "click": {
            const input = decodeClick(request.input);
            if (input.x !== undefined && input.y !== undefined)
              await page.mouse.click(input.x, input.y);
            else
              await page
                .locator(input.locator ?? input.selector!)
                .click({ timeout: input.timeoutMs ?? timeout });
            break;
          }
          case "type": {
            const input = decodeType(request.input);
            const locator = page.locator(input.locator ?? input.selector ?? ":focus");
            if (input.clear)
              await locator.fill(input.text, { timeout: input.timeoutMs ?? timeout });
            else
              await locator.pressSequentially(input.text, { timeout: input.timeoutMs ?? timeout });
            break;
          }
          case "press": {
            const input = decodePress(request.input);
            await page.keyboard.press([...(input.modifiers ?? []), input.key].join("+"));
            break;
          }
          case "scroll": {
            const input = decodeScroll(request.input);
            if (input.locator ?? input.selector)
              await page
                .locator(input.locator ?? input.selector!)
                .evaluate((element, delta) => element.scrollBy(delta.x, delta.y), {
                  x: input.deltaX ?? 0,
                  y: input.deltaY ?? 0,
                });
            else await page.mouse.wheel(input.deltaX ?? 0, input.deltaY ?? 0);
            break;
          }
          case "evaluate": {
            const input = decodeEvaluate(request.input);
            const cdp = await page.context().newCDPSession(page);
            try {
              const result = await cdp.send("Runtime.evaluate", {
                expression: input.expression,
                awaitPromise: input.awaitPromise ?? true,
                returnByValue: input.returnByValue ?? true,
                timeout,
              });
              if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
              const value = input.returnByValue === false ? result.result : result.result.value;
              if (Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") > 64000)
                throw new Error("The browser evaluation result exceeds 64000 bytes.");
              return value;
            } finally {
              await cdp.detach();
            }
          }
          case "waitFor": {
            const input = decodeWaitFor(request.input);
            if (input.locator ?? input.selector)
              await page
                .locator(input.locator ?? input.selector!)
                .waitFor({ state: "visible", timeout: input.timeoutMs ?? timeout });
            if (input.text)
              await page.waitForFunction(
                "text => document.body?.innerText.includes(text)",
                input.text,
                { timeout: input.timeoutMs ?? timeout },
              );
            if (input.urlIncludes)
              await page.waitForURL((url) => url.href.includes(input.urlIncludes!), {
                timeout: input.timeoutMs ?? timeout,
              });
            break;
          }
          case "setColorScheme": {
            const input = decodeSetColorScheme(request.input);
            await page.emulateMedia({
              colorScheme: input.colorScheme === "system" ? null : input.colorScheme,
            });
            return { tabId, colorScheme: input.colorScheme };
          }
          default:
            throw new Error(`Server browser ${request.operation} is not supported.`);
        }
        return undefined;
      }),
    );
    yield* report(threadId, tabId, tab.page);
    return request.operation === "evaluate" ? result : (result ?? (yield* status(threadId, tabId)));
  });
  return ServerBrowser.of({
    install: engine.install,
    installation: engine.installation,
    open,
    navigate,
    resize,
    refresh,
    close,
    control,
    watch,
    invoke,
  });
});

export const layer = Layer.effect(ServerBrowser, make);
