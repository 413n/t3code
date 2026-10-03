import { waitForTitleRegenerationFailure } from "@t3tools/client-runtime/state/title-regeneration";
import type { CommandId, ScopedThreadRef } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadShells } from "../state/threads";

const TITLE_REGENERATION_TIMEOUT_MS = 5 * 60_000;

/**
 * Title regeneration runs in the background after its command is accepted.
 * Watches the given requests and shows one toast with the server's reason if
 * any of them fail.
 */
export function reportTitleRegenerationFailures(
  requests: ReadonlyArray<{ readonly threadRef: ScopedThreadRef; readonly requestId: CommandId }>,
): void {
  if (requests.length === 0) return;
  void Promise.all(
    requests.map(({ threadRef, requestId }) =>
      waitForTitleRegenerationFailure({
        registry: appAtomRegistry,
        atom: environmentThreadShells.threadShellAtom(threadRef),
        requestId,
        timeoutMs: TITLE_REGENERATION_TIMEOUT_MS,
      }),
    ),
  ).then((failures) => {
    const reasons = failures.filter((failure) => failure !== null);
    const [reason] = reasons;
    if (reason === undefined) return;
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title:
          reasons.length === 1
            ? "Failed to regenerate thread title"
            : `Failed to regenerate ${reasons.length} thread titles`,
        description: reason,
      }),
    );
  });
}
