import {
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  type PreviewAutomationError,
  type PreviewTabId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";

export class PreviewTextExportError extends Schema.TaggedError<PreviewTextExportError>()(
  "PreviewTextExportError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not save the loaded page text. The page may have changed or the file could not be written.";
  }
}

const Capture = Schema.Struct({
  totalChars: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  url: Schema.String.check(Schema.isMaxLength(2048)),
});
const TextChunk = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(4096)),
  next: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const encodeKey = Schema.encodeEffect(Schema.fromJsonString(Schema.String));
const decodeCapture = Schema.decodeUnknownEffect(Capture);
const decodeTextChunk = Schema.decodeUnknownEffect(TextChunk);
const decodeStatus = Schema.decodeUnknownEffect(PreviewAutomationStatus);
const decodeSnapshot = Schema.decodeUnknownEffect(PreviewAutomationSnapshot);

export class PreviewScreenshotSaveError extends Schema.TaggedError<PreviewScreenshotSaveError>()(
  "PreviewScreenshotSaveError",
  { screenshotPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not save preview screenshot to ${this.screenshotPath}.`;
  }
}

interface SnapshotInput {
  readonly scope: PreviewAutomationBroker.PreviewAutomationInvokeInput["scope"];
  readonly tabId?: PreviewTabId | undefined;
  readonly saveText?: boolean | undefined;
  readonly save?: boolean | undefined;
}

interface SnapshotCapture {
  readonly snapshot: PreviewAutomationSnapshot;
  readonly png: Uint8Array;
  readonly textExport?: {
    readonly textPath: string;
    readonly totalChars: number;
    readonly sizeBytes: number;
    readonly url: string;
    readonly tabId: PreviewTabId;
  };
  readonly screenshotPath?: string;
}

export class PreviewSnapshot extends Context.Service<
  PreviewSnapshot,
  {
    readonly withSnapshot: <A, E, R>(
      input: SnapshotInput,
      use: (capture: SnapshotCapture) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<
      A,
      | E
      | PreviewAutomationError
      | PreviewTextExportError
      | PreviewScreenshotSaveError
      | Schema.SchemaError,
      R
    >;
  }
>()("t3/preview/Snapshot/PreviewSnapshot") {}

const screenshotSiteSlug = (rawUrl: string): string => {
  try {
    const slug = new URL(rawUrl).hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "");
    return slug || "site";
  } catch {
    return "site";
  }
};

const make = Effect.gen(function* () {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;

  const saveText = Effect.fn("PreviewSnapshot.saveText")(function* (
    scope: SnapshotInput["scope"],
    requestedTabId?: PreviewTabId,
  ) {
    const id = NodeCrypto.randomUUID();
    let tabId = requestedTabId;
    if (tabId === undefined) {
      const status = yield* broker.invoke({ scope, operation: "status", input: {} }).pipe(
        Effect.flatMap(decodeStatus),
        Effect.mapError((cause) => new PreviewTextExportError({ cause })),
      );
      if (!status.available || status.tabId === null) {
        return yield* new PreviewTextExportError({ cause: "No available preview tab." });
      }
      tabId = status.tabId;
    }
    const key = yield* encodeKey(`__t3_text_export_${id}`).pipe(Effect.orDie);
    const textPath = path.join(config.browserArtifactsDir, `browser-text-${id}.txt`);
    const evaluate = (expression: string) =>
      broker.invoke({
        scope,
        operation: "evaluate",
        tabId,
        input: { expression, returnByValue: true },
        updateCurrentTab: false,
      });
    let created = false;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          evaluate(`(() => {
            const capture = globalThis[${key}];
            capture?.dispose();
            return true;
          })()`).pipe(Effect.interruptible, Effect.timeoutOption(5000), Effect.ignore),
        );
        const capture = yield* evaluate(`(() => {
          const text = document.body?.innerText ?? "";
          let timer;
          const dispose = () => {
            clearTimeout(timer);
            if (globalThis[${key}] === capture) delete globalThis[${key}];
          };
          const refresh = () => {
            clearTimeout(timer);
            timer = setTimeout(dispose, 300000);
          };
          const capture = Object.freeze({ text, url: location.href, dispose, refresh });
          Object.defineProperty(globalThis, ${key}, { value: capture, configurable: true });
          refresh();
          return { totalChars: text.length, url: capture.url.slice(0, 2048) };
      })()`).pipe(Effect.flatMap(decodeCapture));
        yield* fileSystem.makeDirectory(config.browserArtifactsDir, { recursive: true });
        const file = yield* Effect.uninterruptible(
          fileSystem.open(textPath, { flag: "wx", mode: 0o600 }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                created = true;
              }),
            ),
          ),
        );
        let offset = 0;
        let sizeBytes = 0;
        while (offset < capture.totalChars) {
          const chunk = yield* evaluate(`(() => {
            const capture = globalThis[${key}];
            if (!capture || capture.url !== location.href) throw new Error("Text capture lost.");
            let end = Math.min(${offset} + 4096, capture.text.length);
            if (end < capture.text.length) {
              const last = capture.text.charCodeAt(end - 1);
              const next = capture.text.charCodeAt(end);
              if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
            }
            capture.refresh();
            return { text: capture.text.slice(${offset}, end), next: end };
        })()`).pipe(Effect.flatMap(decodeTextChunk));
          if (
            chunk.next !== offset + chunk.text.length ||
            chunk.next <= offset ||
            chunk.next > capture.totalChars
          ) {
            return yield* new PreviewTextExportError({ cause: "Invalid text capture chunk." });
          }
          const bytes = new TextEncoder().encode(chunk.text);
          yield* file.writeAll(bytes);
          sizeBytes += bytes.byteLength;
          offset = chunk.next;
        }
        yield* file.sync;
        return { textPath, totalChars: capture.totalChars, sizeBytes, url: capture.url, tabId };
      }),
    ).pipe(
      Effect.onExit((exit) =>
        created && exit._tag === "Failure"
          ? fileSystem.remove(textPath).pipe(Effect.ignore)
          : Effect.void,
      ),
      Effect.mapError((cause) => new PreviewTextExportError({ cause })),
    );
  });

  const saveScreenshot = Effect.fn("PreviewSnapshot.saveScreenshot")(function* (
    pageUrl: string,
    data: Uint8Array,
  ) {
    const millis = yield* Clock.currentTimeMillis;
    const fileName = `browser-screenshot-${screenshotSiteSlug(pageUrl)}-${millis.toString(36)}-${NodeCrypto.randomUUID().slice(0, 8)}.png`;
    const screenshotPath = path.join(config.browserArtifactsDir, fileName);
    yield* fileSystem.makeDirectory(config.browserArtifactsDir, { recursive: true }).pipe(
      Effect.andThen(fileSystem.writeFile(screenshotPath, data)),
      Effect.mapError((cause) => new PreviewScreenshotSaveError({ screenshotPath, cause })),
    );
    return screenshotPath;
  });

  const withSnapshot = Effect.fn("PreviewSnapshot.withSnapshot")(function* <A, E, R>(
    input: SnapshotInput,
    use: (capture: SnapshotCapture) => Effect.Effect<A, E, R>,
  ) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        let textExport: SnapshotCapture["textExport"];
        if (input.saveText === true) {
          textExport = yield* restore(saveText(input.scope, input.tabId));
        }
        const exportedText = textExport;
        return yield* restore(
          Effect.gen(function* () {
            const tabId = exportedText?.tabId ?? input.tabId;
            const snapshot = yield* broker
              .invoke({
                scope: input.scope,
                operation: "snapshot",
                input: {},
                ...(tabId === undefined ? {} : { tabId }),
              })
              .pipe(Effect.flatMap(decodeSnapshot));
            const png = new Uint8Array(Buffer.from(snapshot.screenshot.data, "base64"));
            const screenshotPath =
              input.save === true ? yield* saveScreenshot(snapshot.url, png) : undefined;
            return yield* use({
              snapshot,
              png,
              ...(exportedText === undefined ? {} : { textExport: exportedText }),
              ...(screenshotPath === undefined ? {} : { screenshotPath }),
            });
          }),
        ).pipe(
          Effect.onExit((exit) =>
            exportedText !== undefined && exit._tag === "Failure"
              ? fileSystem.remove(exportedText.textPath).pipe(Effect.ignore)
              : Effect.void,
          ),
        );
      }),
    );
  });

  return PreviewSnapshot.of({ withSnapshot });
});

export const layer = Layer.effect(PreviewSnapshot, make);
