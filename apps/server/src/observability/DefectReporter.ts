import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as ErrorReporter from "effect/ErrorReporter";

/**
 * Logs defects that reach a reporting boundary: RPC handlers, HTTP routes and
 * HttpApi endpoints. Typed failures are expected responses, and HttpApi reports
 * every one of them, so they are not logged.
 *
 * Errors first seen as typed failures are remembered. HttpApi reports a bad
 * request as a failure and then rethrows it as a defect so the HTTP layer answers
 * 400, and that second report must not be logged. Ignored errors, such as the
 * response HttpEffect attaches to every failed request, are skipped.
 */
const make = (): ErrorReporter.ErrorReporter => {
  const seen = new WeakSet<object>();
  return {
    [ErrorReporter.TypeId]: ErrorReporter.TypeId,
    report: ({ cause, fiber }) => {
      if (seen.has(cause)) return;
      seen.add(cause);
      for (const reason of cause.reasons) {
        if (reason._tag === "Interrupt") continue;
        const value = reason._tag === "Fail" ? reason.error : reason.defect;
        if (typeof value === "object" && value !== null) {
          if (seen.has(value)) continue;
          seen.add(value);
        }
        if (reason._tag === "Fail" || ErrorReporter.isIgnored(value)) continue;
        // Reporters are called synchronously from the failing fiber. Logging with
        // its context keeps its loggers and annotations, and a fork cannot throw
        // back into the boundary that reported.
        Effect.runForkWith(fiber.context)(
          Effect.logError("Unhandled defect", Cause.fromReasons([reason])),
        );
      }
    },
  };
};

export const layer = ErrorReporter.layer([Effect.sync(make)]);
