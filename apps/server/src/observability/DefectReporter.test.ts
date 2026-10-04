import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as ErrorReporter from "effect/ErrorReporter";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Rpc, RpcGroup, RpcMessage, RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { WS_RPC_SERVER_OPTIONS } from "../ws.ts";
import * as DefectReporter from "./DefectReporter.ts";

class TestRpcs extends RpcGroup.make(
  Rpc.make("subscribe", { success: Schema.Number, stream: true }),
  Rpc.make("boom", { success: Schema.Void }),
) {}

/** Runs `body` with the defect reporter installed and every error log captured. */
const withErrorLogs = <A, E, R>(
  body: (logs: Queue.Queue<Cause.Cause<unknown>>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const logs = yield* Queue.unbounded<Cause.Cause<unknown>>();
    const logger = Logger.make(({ cause, logLevel }) => {
      if (logLevel === "Error") Queue.offerUnsafe(logs, cause);
    });
    return yield* body(logs).pipe(
      Effect.provide(
        Layer.merge(DefectReporter.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

const errorMessage = (cause: Cause.Cause<unknown>) => (Cause.squash(cause) as Error).message;

describe("DefectReporter", () => {
  it.effect("a dying RPC handler fails alone, and its defect is logged", () =>
    withErrorLogs((logs) =>
      Effect.gen(function* () {
        const subscription = yield* Queue.unbounded<number>();
        const responses = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
        const receive = yield* Deferred.make<Parameters<RpcServer.Protocol["Service"]["run"]>[0]>();
        const protocol = yield* RpcServer.Protocol.make((write) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(receive, write);
            const serialization = yield* RpcSerialization.RpcSerialization;
            return {
              disconnects: yield* Queue.unbounded<number>(),
              send: (_clientId, response) => Queue.offer(responses, response),
              end: () => Effect.void,
              clientIds: Effect.succeed(new Set([0])),
              initialMessage: Effect.succeedNone,
              supportsAck: true,
              supportsTransferables: false,
              supportsSpanPropagation: false,
              supportsNotifications: true,
              codecFor: serialization.codecFor,
            };
          }),
        );
        yield* RpcServer.make(TestRpcs, WS_RPC_SERVER_OPTIONS).pipe(
          Effect.provide(
            TestRpcs.toLayer({
              subscribe: () => Stream.fromQueue(subscription),
              boom: () => Effect.die(new Error("handler bug")),
            }),
          ),
          Effect.provideService(RpcServer.Protocol, protocol),
          Effect.forkScoped,
        );
        const write = yield* Deferred.await(receive);

        yield* write(0, { _tag: "Request", id: "1", tag: "subscribe", payload: null, headers: [] });
        yield* Queue.offer(subscription, 1);
        assert.deepEqual(yield* Queue.take(responses), {
          _tag: "Chunk",
          requestId: "1",
          values: [1],
        });
        yield* write(0, { _tag: "Ack", requestId: "1" });

        yield* write(0, { _tag: "Request", id: "2", tag: "boom", payload: null, headers: [] });
        const boom = yield* Queue.take(responses);
        assert.equal(boom._tag, "Exit");
        if (boom._tag === "Exit") {
          assert.equal(boom.requestId, "2");
          assert.equal(boom.exit._tag, "Failure");
        }
        const logged = yield* Queue.take(logs);
        assert.isTrue(Cause.hasDies(logged));
        assert.equal(errorMessage(logged), "handler bug");

        // The sibling subscription on the same client keeps delivering.
        yield* Queue.offer(subscription, 2);
        assert.deepEqual(yield* Queue.take(responses), {
          _tag: "Chunk",
          requestId: "1",
          values: [2],
        });
        assert.equal(yield* Queue.size(logs), 0);
      }),
    ).pipe(Effect.provide(RpcSerialization.layerJson), Effect.scoped),
  );

  it.effect("does not log typed failures, or a typed failure rethrown as a defect", () =>
    withErrorLogs((logs) =>
      Effect.gen(function* () {
        // HttpApi reports a schema failure, then rethrows the same error as a defect.
        const badRequest = new Error("bad request");
        yield* ErrorReporter.report(Cause.fail(badRequest));
        yield* ErrorReporter.report(Cause.die(badRequest));
        yield* ErrorReporter.report(Cause.fail(new Error("expected")));
        yield* ErrorReporter.report(Cause.die(new Error("bug")));

        assert.equal(errorMessage(yield* Queue.take(logs)), "bug");
        assert.equal(yield* Queue.size(logs), 0);
      }),
    ),
  );
});
