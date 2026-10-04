import { PreviewAutomationStatus, type PreviewTabId } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { requireMcpCapability } from "./McpInvocationContext.ts";
import { PreviewAutomationBroker } from "./PreviewAutomationBroker.ts";

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

export const savePreviewText = Effect.fn("PreviewTextExport.savePreviewText")(function* (
  requestedTabId?: PreviewTabId,
) {
  const scope = yield* requireMcpCapability("preview");
  const broker = yield* PreviewAutomationBroker;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const id = NodeCrypto.randomUUID();
  let tabId = requestedTabId;
  if (tabId === undefined) {
    const status = yield* broker.invoke({ scope, operation: "status", input: {} }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PreviewAutomationStatus)),
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
      })()`).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Capture)));
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
        })()`).pipe(Effect.flatMap(Schema.decodeUnknownEffect(TextChunk)));
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
