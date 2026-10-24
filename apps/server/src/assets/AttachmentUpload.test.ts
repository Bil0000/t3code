// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AttachmentCreateUploadUrlInput,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { temporaryResourceStorage } from "../orchestration-v2/testkit/TemporaryResourceStorage.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/http/HttpRouter";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { base64UrlEncode, signPayload } from "../auth/utils.ts";
import * as ServerConfig from "../config.ts";
import * as TemporaryThreadDiagnostics from "../observability/TemporaryThreadDiagnostics.ts";
import * as TemporaryThreadStorage from "../orchestration-v2/TemporaryThreadStorage.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { layerAttachmentUploadRoute } from "../http.ts";
import {
  ATTACHMENT_UPLOAD_ROUTE_PREFIX,
  deletePendingAttachment,
  issueAttachmentUploadUrl,
  storeAttachmentUpload,
  validateAttachmentUploadToken,
} from "./AttachmentUpload.ts";

const layerTest = ServerSecretStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-attachment-upload-" })),
  Layer.provideMerge(NodeServices.layer),
);

const uploadInput = {
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 6,
} as const;

const layerOwnership = Layer.mock(TemporaryThreadStorage.TemporaryThreadStorage)({
  isTemporary: (id) => Effect.succeed(id === "private-thread"),
  isDiscarded: (id) => Effect.succeed(id === "discarded-thread"),
});

const layerDraftOwnership = TemporaryThreadStorage.layer.pipe(
  Layer.provide(Sqlite.layerMemory),
  Layer.provideMerge(TemporaryThreadDiagnostics.layer),
);

const LegacyAttachmentUploadClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("attachment-upload"),
  attachmentId: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  expiresAt: Schema.Number,
});
const encodeLegacyAttachmentUploadClaims = Schema.encodeEffect(
  Schema.fromJsonString(LegacyAttachmentUploadClaims),
);
const decodeUploadInput = Schema.decodeEffect(AttachmentCreateUploadUrlInput);

describe("AttachmentUpload", () => {
  it.effect(
    "uploads a normal first draft before, during, and after an unrelated temporary thread",
    () =>
      Effect.gen(function* () {
        const diagnostics = yield* TemporaryThreadDiagnostics.TemporaryThreadDiagnostics;
        const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
        const owner = {
          _tag: "draft" as const,
          draftId: "normal-draft",
          threadId: ThreadId.make("reserved-normal-thread"),
          temporary: false,
        };
        for (const phase of ["before", "active", "discarded"]) {
          if (phase === "active")
            yield* storage.register({ threadId: ThreadId.make("private-thread") });
          if (phase === "discarded") yield* storage.discard(ThreadId.make("private-thread"));
          expect(diagnostics.canRecord()).toBe(phase === "before");
          const issued = yield* issueAttachmentUploadUrl(
            yield* decodeUploadInput({ ...uploadInput, owner }),
          );
          const claims = yield* validateAttachmentUploadToken(
            issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length),
          );
          expect(claims).toMatchObject({ owner });
          if (!claims) throw new Error("Expected signed draft upload claims.");
          expect(yield* storeAttachmentUpload(claims, Stream.make(new Uint8Array(6)))).toEqual({
            ok: true,
          });
        }
      }).pipe(Effect.provide([layerTest, layerDraftOwnership])),
  );

  it.effect(
    "rejects normal draft claims when their reserved thread becomes temporary or discarded",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
        expect(
          yield* Effect.result(
            issueAttachmentUploadUrl({
              ...uploadInput,
              owner: {
                _tag: "draft",
                draftId: "unregistered-temporary",
                threadId: ThreadId.make("unregistered-thread"),
                temporary: true,
              },
            }),
          ),
        ).toMatchObject({ _tag: "Failure" });
        for (const id of ["private-thread", "discarded-thread"]) {
          const owner = {
            _tag: "draft" as const,
            draftId: `draft-${id}`,
            threadId: ThreadId.make(id),
            temporary: false,
          };
          const issued = yield* issueAttachmentUploadUrl({ ...uploadInput, owner });
          yield* storage.register({ threadId: owner.threadId });
          if (id === "discarded-thread") yield* storage.discard(owner.threadId);
          const claims = yield* validateAttachmentUploadToken(
            issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length),
          );
          if (!claims) throw new Error("Expected signed draft upload claims.");
          let consumed = false;
          const body = Stream.fromEffect(
            Effect.sync(() => {
              consumed = true;
              return new Uint8Array(6);
            }),
          );
          expect(yield* storeAttachmentUpload(claims, body)).toMatchObject({
            ok: false,
            status: 409,
          });
          expect(consumed).toBe(false);
          expect(
            yield* Effect.result(issueAttachmentUploadUrl({ ...uploadInput, owner })),
          ).toMatchObject({ _tag: "Failure" });
        }
        expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([]);
      }).pipe(Effect.provide([layerTest, layerDraftOwnership])),
  );

  it.effect("enforces signed ownership through the upload HTTP route", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const diagnostics = yield* TemporaryThreadDiagnostics.TemporaryThreadDiagnostics;
      const issued = [];
      for (const id of ["saved-thread", "private-thread", "discarded-thread"]) {
        issued.push(
          yield* issueAttachmentUploadUrl({
            ...uploadInput,
            owner: { _tag: "thread", threadId: ThreadId.make(id) },
          }).pipe(
            Effect.provide(
              Layer.mock(TemporaryThreadStorage.TemporaryThreadStorage)({
                isTemporary: () => Effect.succeed(false),
                isDiscarded: () => Effect.succeed(false),
              }),
            ),
          ),
        );
      }
      diagnostics.enter(ThreadId.make("private-thread"));
      const services = yield* Effect.context<
        | Layer.Success<typeof layerTest>
        | TemporaryThreadDiagnostics.TemporaryThreadDiagnostics
        | TemporaryThreadStorage.TemporaryThreadStorage
      >();
      const { handler, dispose } = HttpRouter.toWebHandler(layerAttachmentUploadRoute, {
        disableLogger: true,
      });
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      for (const [index, grant] of issued.entries()) {
        const response = yield* Effect.promise(() =>
          handler(
            new Request(`http://environment.test${grant.relativeUrl}`, {
              method: "POST",
              body: new Uint8Array(6),
            }),
            services,
          ),
        );
        expect(response.status).toBe(index === 0 ? 204 : 409);
        expect(
          NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${grant.attachmentId}.png`)),
        ).toBe(index === 0);
      }
      expect(
        NodeFS.readdirSync(config.attachmentsDir).filter((name) => name.endsWith(".part")),
      ).toEqual([]);
    }).pipe(Effect.provide([layerTest, layerOwnership, TemporaryThreadDiagnostics.layer])),
  );

  it.effect("allows saved-owner grants issued before and during another temporary thread", () =>
    Effect.gen(function* () {
      const diagnostics = yield* TemporaryThreadDiagnostics.TemporaryThreadDiagnostics;
      const config = yield* ServerConfig.ServerConfig;
      const owner = { _tag: "thread" as const, threadId: ThreadId.make("saved-thread") };
      const input = yield* decodeUploadInput({ ...uploadInput, owner });
      const before = yield* issueAttachmentUploadUrl(input);
      diagnostics.enter(ThreadId.make("private-thread"));
      const during = yield* issueAttachmentUploadUrl(input);
      for (const issued of [before, during]) {
        const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
        const claims = yield* validateAttachmentUploadToken(token);
        expect(claims).toMatchObject({ owner });
        if (!claims) throw new Error("Expected signed upload claims.");
        expect(yield* storeAttachmentUpload(claims, new Uint8Array(6))).toEqual({ ok: true });
        expect(
          NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${issued.attachmentId}.png`)),
        ).toEqual(Buffer.alloc(6));
      }
    }).pipe(Effect.provide([layerTest, TemporaryThreadDiagnostics.layer, layerOwnership])),
  );

  it.effect("rejects temporary and discarded owners before consuming or writing an upload", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      for (const id of ["private-thread", "discarded-thread"]) {
        const owner = { _tag: "thread" as const, threadId: ThreadId.make(id) };
        expect(
          yield* Effect.result(issueAttachmentUploadUrl({ ...uploadInput, owner })),
        ).toMatchObject({ _tag: "Failure" });
        const issued = yield* issueAttachmentUploadUrl({ ...uploadInput, owner }).pipe(
          Effect.provide(
            Layer.mock(TemporaryThreadStorage.TemporaryThreadStorage)({
              isTemporary: () => Effect.succeed(false),
              isDiscarded: () => Effect.succeed(false),
            }),
          ),
        );
        const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
        const claims = yield* validateAttachmentUploadToken(token);
        if (!claims) throw new Error("Expected signed upload claims.");
        let consumed = false;
        const body = Stream.fromEffect(
          Effect.sync(() => {
            consumed = true;
            return new Uint8Array(6);
          }),
        );
        expect(yield* storeAttachmentUpload(claims, body)).toMatchObject({
          ok: false,
          status: 409,
        });
        expect(consumed).toBe(false);
      }
      expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([]);
    }).pipe(Effect.provide([layerTest, layerOwnership])),
  );

  it.effect(
    "keeps unproved draft and legacy grants closed during temporary work and after discard",
    () =>
      Effect.gen(function* () {
        const diagnostics = yield* TemporaryThreadDiagnostics.TemporaryThreadDiagnostics;
        const config = yield* ServerConfig.ServerConfig;
        const owner = { _tag: "draft" as const, draftId: "new-task:saved-draft" };
        const issued = yield* issueAttachmentUploadUrl(uploadInput);
        const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
        const claims = yield* validateAttachmentUploadToken(token);
        if (!claims) throw new Error("Expected signed upload claims.");
        const privateId = ThreadId.make("private-thread");
        diagnostics.enter(privateId);
        for (const discarded of [false, true]) {
          if (discarded) diagnostics.leave(privateId);
          for (const input of [
            uploadInput,
            { ...uploadInput, owner },
            { ...uploadInput, owner: { ...owner, threadId: ThreadId.make("unproved-thread") } },
          ]) {
            expect(yield* Effect.result(issueAttachmentUploadUrl(input))).toMatchObject({
              _tag: "Failure",
            });
          }
          expect(
            yield* storeAttachmentUpload(claims, Stream.make(new Uint8Array(6))),
          ).toMatchObject({ ok: false, status: 409 });
        }
        expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([]);
      }).pipe(Effect.provide([layerTest, TemporaryThreadDiagnostics.layer])),
  );

  it.effect("rejects tampered and malformed upload tokens", () =>
    Effect.gen(function* () {
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const [payload, signature] = token.split(".");

      expect(yield* validateAttachmentUploadToken(`${payload}x.${signature}`)).toBeNull();
      expect(yield* validateAttachmentUploadToken(`${token}.extra`)).toBeNull();
      expect(yield* validateAttachmentUploadToken("garbage")).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("accepts unexpired image upload tokens issued before file support", () =>
    Effect.gen(function* () {
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const secret = yield* secretStore.getOrCreateRandom("asset-access-signing-key", 32);
      const encodedPayload = base64UrlEncode(
        yield* encodeLegacyAttachmentUploadClaims({
          version: 1,
          kind: "attachment-upload",
          attachmentId: issued.attachmentId,
          name: uploadInput.name,
          mimeType: uploadInput.mimeType,
          sizeBytes: uploadInput.sizeBytes,
          expiresAt: issued.expiresAt,
        }),
      );
      const legacyToken = `${encodedPayload}.${signPayload(encodedPayload, secret)}`;

      expect(yield* validateAttachmentUploadToken(legacyToken)).toMatchObject({
        type: "image",
        attachmentId: issued.attachmentId,
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("stores the expected bytes without leaving temporary files", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      expect(yield* storeAttachmentUpload(claims, new Uint8Array([1, 2, 3]))).toMatchObject({
        ok: false,
        status: 400,
      });
      expect(yield* storeAttachmentUpload(claims, new Uint8Array(6))).toEqual({ ok: true });
      expect(
        NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${issued.attachmentId}.png`)),
      ).toBe(true);
      expect(
        NodeFS.readdirSync(config.attachmentsDir).filter((entry) => entry.endsWith(".part")),
      ).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("streams generic files to a path with their original extension", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const issued = yield* issueAttachmentUploadUrl({
        type: "file",
        name: "report.PDF",
        mimeType: "application/pdf",
        sizeBytes: 6,
      });
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      expect(
        yield* storeAttachmentUpload(
          claims,
          Stream.make(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])),
        ),
      ).toEqual({ ok: true });
      expect(issued.attachmentId).toMatch(/-pdf$/);
      expect(
        NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${issued.attachmentId}.pdf`)),
      ).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));

      yield* deletePendingAttachment(issued.attachmentId);
      expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("removes partial streamed uploads that exceed their signed size", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      expect(yield* storeAttachmentUpload(claims, Stream.make(new Uint8Array(7)))).toMatchObject({
        ok: false,
        status: 400,
      });
      expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("removes partial streamed uploads when the upload is interrupted", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      const nextChunkRequested = yield* Deferred.make<void>();
      const body = Stream.make(new Uint8Array([1, 2, 3])).pipe(
        Stream.concat(
          Stream.fromEffect(
            Deferred.succeed(nextChunkRequested, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        ),
      );
      const upload = yield* storeAttachmentUpload(claims, body).pipe(Effect.forkScoped);

      yield* Deferred.await(nextChunkRequested);
      expect(
        NodeFS.readdirSync(config.attachmentsDir).filter((entry) => entry.endsWith(".part")),
      ).toHaveLength(1);

      yield* Fiber.interrupt(upload);
      expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("deletes pending uploads without deleting thread-owned copies", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const uuid = "00000000-0000-4000-8000-0000000000dd";
      const pendingPath = NodePath.join(config.attachmentsDir, `pending-${uuid}.png`);
      const claimedPath = NodePath.join(config.attachmentsDir, `thread-1-${uuid}.png`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));
      NodeFS.writeFileSync(claimedPath, Buffer.from("pixels"));

      yield* deletePendingAttachment(`pending-${uuid}`);
      yield* deletePendingAttachment(`pending-${uuid}`);
      yield* deletePendingAttachment(`thread-1-${uuid}`);

      expect(NodeFS.existsSync(pendingPath)).toBe(false);
      expect(NodeFS.existsSync(claimedPath)).toBe(true);
    }).pipe(Effect.provide(layerTest)),
  );
});

it.effect("temporary upload preparation fails before issuing a disk upload grant", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      issueAttachmentUploadUrl({
        ...uploadInput,
        owner: { _tag: "thread", threadId: ThreadId.make("saved-thread") },
      }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.message).toContain("Keep this thread");
  }).pipe(
    Effect.provide([
      layerTest,
      temporaryResourceStorage,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("private-environment"),
        requestNamespace: "private-session",
        issuedAt: 0,
        thread: {
          threadId: ThreadId.make("private-thread"),
          providerSessionId: "private-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"] as const),
      }),
    ]),
  ),
);
