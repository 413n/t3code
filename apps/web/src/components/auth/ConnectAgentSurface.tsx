import {
  AuthMcpApprovalDetails,
  AuthMcpApprovalError,
  AuthMcpApprovalResult,
  AuthMcpClientAccess,
} from "@t3tools/contracts";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { EyeIcon, type LucideIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { runtimeModeConfig } from "../chat/runtimeModeConfig";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";
import { AuthSurfaceShell } from "./AuthSurfaceShell";

const decodeDetails = Schema.decodeUnknownOption(AuthMcpApprovalDetails);
const decodeResult = Schema.decodeUnknownOption(AuthMcpApprovalResult);
const decodeError = Schema.decodeUnknownOption(AuthMcpApprovalError);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const accessConfig: Record<
  AuthMcpClientAccess,
  { readonly label: string; readonly description: string; readonly icon: LucideIcon }
> = {
  "read-only": {
    label: "Read only",
    description: "Read projects and threads. Cannot start, message or change anything.",
    icon: EyeIcon,
  },
  ...runtimeModeConfig,
};

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "invalid"; readonly message: string }
  | { readonly status: "ready"; readonly details: AuthMcpApprovalDetails };

/**
 * Posts the agent's sign-in request, which the server validates again on every
 * call. Answers either the JSON the caller expects, a message to show, or a
 * URL the browser must follow (an approval, a denial, or a protocol error the
 * agent should receive).
 */
async function postApproval(
  path: "/oauth/mcp/approval" | "/oauth/mcp/decision",
  body: Record<string, string>,
): Promise<
  | { readonly kind: "body"; readonly body: unknown }
  | { readonly kind: "redirect"; readonly url: string }
  | { readonly kind: "error"; readonly message: string }
> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: encodeJson(body),
  }).catch(() => undefined);
  if (response === undefined) {
    return { kind: "error", message: "Could not reach this environment. Try again." };
  }
  const payload: unknown = await response.json().catch(() => undefined);
  const redirect = decodeResult(payload);
  if (redirect._tag === "Some") return { kind: "redirect", url: redirect.value.redirectTo };
  if (!response.ok) {
    const error = decodeError(payload);
    return {
      kind: "error",
      message: error._tag === "Some" ? error.value.error : "The sign-in could not continue.",
    };
  }
  return { kind: "body", body: payload };
}

function readRequestParams(): Record<string, string> {
  return Object.fromEntries(new URL(window.location.href).searchParams);
}

/**
 * /connect-agent: where an outside agent's MCP sign-in lands after the server
 * checks the request. The user picks the most the agent may allow, then
 * approves with a pairing code, or in one click when this browser is already
 * signed in to the environment as an administrator.
 */
export function ConnectAgentSurface() {
  const [params] = useState(readRequestParams);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [access, setAccess] = useState<AuthMcpClientAccess>("read-only");
  const [pairingCode, setPairingCode] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);

  useEffect(() => {
    let cancelled = false;
    void postApproval("/oauth/mcp/approval", params).then((answer) => {
      if (cancelled) return;
      if (answer.kind === "redirect") {
        window.location.replace(answer.url);
        return;
      }
      if (answer.kind === "error") {
        setLoaded({ status: "invalid", message: answer.message });
        return;
      }
      const details = decodeDetails(answer.body);
      setLoaded(
        details._tag === "Some"
          ? { status: "ready", details: details.value }
          : { status: "invalid", message: "The sign-in could not continue." },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [params]);

  const decide = useCallback(
    async (decision: "approve" | "deny") => {
      if (loaded.status !== "ready") return;
      setPending(decision);
      setErrorMessage("");
      const answer = await postApproval("/oauth/mcp/decision", {
        ...params,
        decision,
        access,
        ...(loaded.details.csrfToken === undefined
          ? { pairing_code: pairingCode.trim() }
          : { csrf_token: loaded.details.csrfToken }),
      });
      if (answer.kind === "redirect") {
        window.location.replace(answer.url);
        return;
      }
      setPending(null);
      setErrorMessage(answer.kind === "error" ? answer.message : "The sign-in could not continue.");
    },
    [access, loaded, params, pairingCode],
  );

  if (loaded.status === "loading") {
    return (
      <AuthSurfaceShell>
        <ConnectAgentHeading
          title="Checking the sign-in request"
          description="One moment while this environment verifies the agent's request."
        />
        <Spinner className="mt-6" size="lg" tone="muted" />
      </AuthSurfaceShell>
    );
  }

  if (loaded.status === "invalid") {
    return (
      <AuthSurfaceShell>
        <ConnectAgentHeading title="This sign-in cannot continue" description={loaded.message} />
        <p className="mt-4 text-sm text-muted-foreground">
          Close this page and start the sign-in again from your agent.
        </p>
      </AuthSurfaceShell>
    );
  }

  const { details } = loaded;
  const oneClick = details.csrfToken !== undefined;
  const canApprove = pending === null && (oneClick || pairingCode.trim().length > 0);

  return (
    <AuthSurfaceShell>
      <ConnectAgentHeading
        title={`Connect ${details.clientName}`}
        description={
          <>
            This agent wants to use the threads in every project on{" "}
            <span className="font-medium text-foreground">{details.environmentHost}</span>.
          </>
        }
      />
      <p className="mt-2 text-xs text-muted-foreground">
        The name is chosen by the agent. Approval returns to {details.redirectHost} on the computer
        that opened this page. Only approve a sign-in you just started.
      </p>

      <form
        className="mt-6 space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (canApprove) void decide("approve");
        }}
      >
        <div className="space-y-2">
          <span id="connect-agent-access-label" className="text-sm font-medium">
            What it may do
          </span>
          <RadioGroup
            aria-labelledby="connect-agent-access-label"
            value={access}
            onValueChange={(value) => setAccess(value as AuthMcpClientAccess)}
          >
            {AuthMcpClientAccess.literals.map((option) => (
              <AccessOption key={option} access={option} selected={option === access} />
            ))}
          </RadioGroup>
          <p className="text-xs text-muted-foreground">
            Beyond read only, it can start, message and stop threads, and none of them can run with
            more than the mode you pick.
          </p>
        </div>

        {oneClick ? null : (
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="connect-agent-pairing-code">
              Pairing code
            </label>
            <Input
              id="connect-agent-pairing-code"
              autoCapitalize="none"
              autoComplete="one-time-code"
              autoCorrect="off"
              disabled={pending !== null}
              nativeInput
              onChange={(event) => setPairingCode(event.currentTarget.value)}
              placeholder="Paste a one-time pairing code"
              spellCheck={false}
              value={pairingCode}
            />
            <p className="text-xs text-muted-foreground">
              Create one in Settings → Connections, or run <code>t3 auth pairing create</code> on
              this machine.
            </p>
          </div>
        )}

        {errorMessage ? (
          <Alert variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button disabled={!canApprove} type="submit">
            {pending === "approve" ? "Approving…" : "Approve"}
          </Button>
          <Button
            disabled={pending !== null}
            onClick={() => void decide("deny")}
            type="button"
            variant="outline"
          >
            {pending === "deny" ? "Denying…" : "Deny"}
          </Button>
        </div>
      </form>
    </AuthSurfaceShell>
  );
}

function ConnectAgentHeading({
  title,
  description,
}: {
  readonly title: string;
  readonly description: ReactNode;
}) {
  return (
    <>
      <p className="text-3xs font-semibold tracking-widest text-primary uppercase">Agent sign-in</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
    </>
  );
}

function AccessOption({
  access,
  selected,
}: {
  readonly access: AuthMcpClientAccess;
  readonly selected: boolean;
}) {
  const { label, description, icon: Icon } = accessConfig[access];
  return (
    <RadioPrimitive.Root
      value={access}
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        selected
          ? "border-primary bg-background ring-2 ring-primary/25 dark:border-transparent dark:bg-primary/10 dark:ring-1 dark:ring-primary/30"
          : "border-border bg-background hover:bg-muted/50 dark:border-transparent dark:bg-white/[0.035] dark:hover:bg-accent",
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "mt-0.5 size-4 shrink-0",
          selected ? "text-primary" : "text-muted-foreground",
        )}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </RadioPrimitive.Root>
  );
}
