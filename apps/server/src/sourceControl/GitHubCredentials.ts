import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";

import * as VcsProcess from "../vcs/VcsProcess.ts";

/** How long a token is reused before `gh` is asked again, so a `gh auth switch` applies soon. */
const TOKEN_TTL = Duration.minutes(5);
/** No credential is retried sooner, so a fresh `gh auth login` takes effect on the next read. */
const MISSING_TTL = Duration.seconds(10);

export const GitHubCredentialSource = Schema.Literals(["env", "gh"]);
export type GitHubCredentialSource = typeof GitHubCredentialSource.Type;

export interface GitHubCredential {
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
  readonly source: GitHubCredentialSource;
  /** A digest of host and token: safe for cache keys and rate-limit scopes, never the token. */
  readonly fingerprint: string;
}

/** Nothing in the environment, and no `gh` on PATH to ask. */
export class GitHubCliMissingError extends Schema.TaggedError<GitHubCliMissingError>()(
  "GitHubCliMissingError",
  { host: Schema.String },
) {
  get detail(): string {
    return `No GitHub credential for ${this.host}: set GH_TOKEN, or install the GitHub CLI and run \`gh auth login\`.`;
  }

  override get message(): string {
    return this.detail;
  }
}

/** `gh` is installed but holds no login for the host. */
export class GitHubNotSignedInError extends Schema.TaggedError<GitHubNotSignedInError>()(
  "GitHubNotSignedInError",
  { host: Schema.String },
) {
  get detail(): string {
    return `No GitHub credential for ${this.host}: run \`gh auth login --hostname ${this.host}\`.`;
  }

  override get message(): string {
    return this.detail;
  }
}

/** There is no token for the host. */
export type GitHubCredentialUnavailableError = GitHubCliMissingError | GitHubNotSignedInError;

/**
 * Where GitHub tokens come from. Callers ask per host and never see how the token was found,
 * so another source (an in-app OAuth login) slots in here without touching any of them.
 */
export class GitHubCredentials extends Context.Service<
  GitHubCredentials,
  {
    readonly get: (
      host: string,
    ) => Effect.Effect<GitHubCredential, GitHubCredentialUnavailableError>;
    /** Drops the held token after GitHub refused it, so the next read asks its source again. */
    readonly invalidate: (host: string) => Effect.Effect<void>;
  }
>()("t3/sourceControl/GitHubCredentials") {}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

/** Hosts gh treats as GitHub.com-like for `GH_TOKEN`: github.com and GHE.com data residency. */
function isGitHubDotCom(host: string): boolean {
  return host === "github.com" || host.endsWith(".ghe.com");
}

/** The environment variables gh itself reads for a host, in its precedence order. */
export function environmentToken(
  host: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const names = isGitHubDotCom(host)
    ? ["GH_TOKEN", "GITHUB_TOKEN"]
    : ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

export function credentialFingerprint(host: string, token: string): string {
  return `${host}:${NodeCrypto.createHash("sha256").update(token).digest("hex")}`;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const fromGh = (host: string) =>
    process
      .run({
        operation: "GitHubCredentials.get",
        command: "gh",
        args: ["auth", "token", "--hostname", host],
        cwd: globalThis.process.cwd(),
        // Never let gh print the token into a debug log.
        env: { GH_DEBUG: "", GH_PROMPT_DISABLED: "1" },
        timeoutMs: 10_000,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "VcsProcessSpawnError" &&
          error.cause instanceof PlatformError.PlatformError &&
          error.cause.reason._tag === "NotFound"
            ? new GitHubCliMissingError({ host })
            : new GitHubNotSignedInError({ host }),
        ),
        Effect.map((output) => output.stdout.trim()),
        Effect.filterOrFail(
          (token) => token !== "",
          () => new GitHubNotSignedInError({ host }),
        ),
      );

  const lookup = Effect.fn("GitHubCredentials.lookup")(function* (host: string) {
    const fromEnv = environmentToken(host, globalThis.process.env);
    const token = fromEnv ?? (yield* fromGh(host));
    return {
      host,
      token: Redacted.make(token),
      source: fromEnv !== null ? "env" : "gh",
      fingerprint: credentialFingerprint(host, token),
    } satisfies GitHubCredential;
  });

  const cache = yield* Cache.makeWith(lookup, {
    capacity: 32,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? TOKEN_TTL : MISSING_TTL),
  });

  return GitHubCredentials.of({
    get: (host) => Cache.get(cache, normalizeHost(host)),
    invalidate: (host) => Cache.invalidate(cache, normalizeHost(host)),
  });
});

export const layer = Layer.effect(GitHubCredentials, make);
