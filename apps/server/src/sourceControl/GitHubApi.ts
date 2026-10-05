import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubGraphQlBudget from "./githubGraphQlBudget.ts";
import * as SourceControlRateLimit from "./SourceControlRateLimit.ts";

const DEFAULT_TIMEOUT = Duration.seconds(30);
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Polite to GitHub's secondary limits, which punish bursts of concurrent requests. */
const CONCURRENCY = 8;
const API_VERSION = "2022-11-28";

/**
 * A credential already verified for one host. Every request made under it must target that
 * host, so a page cannot read one account's data with another's token mid-flight. Server-local:
 * never put its value in RPC payloads or cache keys.
 */
export const PinnedGitHubCredential = Context.Reference<{
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
  readonly credentialFingerprint: string;
} | null>("t3/sourceControl/PinnedGitHubCredential", { defaultValue: () => null });

export class GitHubApiRequestError extends Schema.TaggedError<GitHubApiRequestError>()(
  "GitHubApiRequestError",
  { host: Schema.String, operation: Schema.String, cause: Schema.Defect() },
) {
  get detail(): string {
    return `Could not reach GitHub at ${this.host}.`;
  }

  override get message(): string {
    return `GitHub API failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitHubApiAuthenticationError extends Schema.TaggedError<GitHubApiAuthenticationError>()(
  "GitHubApiAuthenticationError",
  { host: Schema.String, operation: Schema.String },
) {
  get detail(): string {
    return `GitHub refused the credential for ${this.host}. Run \`gh auth login --hostname ${this.host}\` and retry.`;
  }

  override get message(): string {
    return `GitHub API failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitHubApiRateLimitError extends Schema.TaggedError<GitHubApiRateLimitError>()(
  "GitHubApiRateLimitError",
  {
    host: Schema.String,
    operation: Schema.String,
    retryAt: Schema.optionalKey(Schema.Finite),
  },
) {
  get detail(): string {
    return "GitHub API rate limit exceeded.";
  }

  override get message(): string {
    return `GitHub API failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitHubApiNotFoundError extends Schema.TaggedError<GitHubApiNotFoundError>()(
  "GitHubApiNotFoundError",
  { host: Schema.String, operation: Schema.String },
) {
  get detail(): string {
    return "GitHub could not find the requested resource, or the credential cannot see it.";
  }

  override get message(): string {
    return `GitHub API failed in ${this.operation}: ${this.detail}`;
  }
}

/**
 * GitHub answered with a failure that is none of the above. `graphqlErrors` carries GitHub's own
 * error messages for a GraphQL answer: they name the field and the reason, never a token.
 */
export class GitHubApiResponseError extends Schema.TaggedError<GitHubApiResponseError>()(
  "GitHubApiResponseError",
  {
    host: Schema.String,
    operation: Schema.String,
    status: Schema.Int,
    graphqlErrors: Schema.optionalKey(Schema.Array(Schema.String)),
  },
) {
  get detail(): string {
    return this.graphqlErrors !== undefined && this.graphqlErrors.length > 0
      ? `GitHub returned an error: ${this.graphqlErrors.join("; ")}`
      : `GitHub returned HTTP ${this.status}.`;
  }

  override get message(): string {
    return `GitHub API failed in ${this.operation}: ${this.detail}`;
  }
}

export type GitHubApiError =
  | GitHubCredentials.GitHubCredentialUnavailableError
  | GitHubApiRequestError
  | GitHubApiAuthenticationError
  | GitHubApiRateLimitError
  | GitHubApiNotFoundError
  | GitHubApiResponseError
  | SourceControlRateLimit.SourceControlRateLimitPausedError;

export interface GitHubRestResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
  readonly truncated: boolean;
}

export interface GitHubRestInput {
  readonly host: string;
  readonly operation: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Relative to the API root, e.g. `repos/acme/web/pulls/7`; query string included. */
  readonly path: string;
  readonly body?: unknown;
  /** Defaults to `application/vnd.github+json`. */
  readonly accept?: string;
  /** Revalidates a cached answer. A 304 is returned rather than failed, and is free. */
  readonly ifNoneMatch?: string;
  readonly maxResponseBytes?: number;
  /** Interactive reads may run through a pause, the way they may spend the GraphQL reserve. */
  readonly allowReserve?: boolean;
}

export interface GitHubGraphQlInput {
  readonly host: string;
  readonly operation: string;
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly allowReserve?: boolean;
}

export class GitHubApi extends Context.Service<
  GitHubApi,
  {
    /** The raw JSON body of a successful GraphQL answer, with `rateLimit` recorded. */
    readonly graphql: (input: GitHubGraphQlInput) => Effect.Effect<string, GitHubApiError>;
    readonly rest: (input: GitHubRestInput) => Effect.Effect<GitHubRestResponse, GitHubApiError>;
    /** The credential a request to `host` would carry right now. */
    readonly credential: (
      host: string,
    ) => Effect.Effect<
      { readonly token: Redacted.Redacted<string>; readonly fingerprint: string },
      GitHubApiError
    >;
  }
>()("t3/sourceControl/GitHubApi") {}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

/**
 * Where the API for a host lives. github.com and GHE.com data residency serve it from an `api.`
 * subdomain; GitHub Enterprise Server serves it under `/api` on the instance itself.
 */
export function gitHubApiUrls(host: string): { readonly rest: string; readonly graphql: string } {
  const normalized = normalizeHost(host);
  if (normalized === "github.com") {
    return { rest: "https://api.github.com", graphql: "https://api.github.com/graphql" };
  }
  if (normalized.endsWith(".ghe.com")) {
    return {
      rest: `https://api.${normalized}`,
      graphql: `https://api.${normalized}/graphql`,
    };
  }
  return { rest: `https://${normalized}/api/v3`, graphql: `https://${normalized}/api/graphql` };
}

/** The pause GitHub asked for, from `retry-after` or the primary limit's reset. */
function retryAtFrom(
  headers: Readonly<Record<string, string | undefined>>,
  now: number,
): number | undefined {
  const fromRetryAfter = SourceControlRateLimit.retryAtFromHeader(headers["retry-after"], now);
  if (fromRetryAfter !== undefined) return fromRetryAfter;
  const reset = Number(headers["x-ratelimit-reset"]) * 1_000;
  return Number.isFinite(reset) && reset > now ? reset : undefined;
}

function isRateLimited(
  status: number,
  headers: Readonly<Record<string, string | undefined>>,
  body: string,
) {
  return (
    status === 429 ||
    (status === 403 &&
      (headers["x-ratelimit-remaining"] === "0" ||
        headers["retry-after"] !== undefined ||
        /rate limit/i.test(body)))
  );
}

interface GraphQlErrors {
  readonly messages: ReadonlyArray<string>;
  readonly types: ReadonlyArray<string>;
}

const decodeGraphQlErrors = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      errors: Schema.NonEmptyArray(
        Schema.Struct({
          type: Schema.optional(Schema.String),
          message: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

function graphqlErrors(body: string): GraphQlErrors | null {
  return Option.match(decodeGraphQlErrors(body), {
    onNone: () => null,
    onSome: ({ errors }) => ({
      messages: errors.flatMap((error) => (error.message === undefined ? [] : [error.message])),
      types: errors.flatMap((error) => (error.type === undefined ? [] : [error.type])),
    }),
  });
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
  const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
  const gate = yield* Semaphore.make(CONCURRENCY);

  const credential: GitHubApi["Service"]["credential"] = Effect.fn("GitHubApi.credential")(
    function* (host) {
      const normalized = normalizeHost(host);
      const pinned = yield* PinnedGitHubCredential;
      if (pinned !== null) {
        // A pinned page only ever talks to the host it verified.
        if (pinned.host !== normalized) {
          return yield* new GitHubApiAuthenticationError({
            host: normalized,
            operation: "credential",
          });
        }
        return { token: pinned.token, fingerprint: pinned.credentialFingerprint };
      }
      const held = yield* credentials.get(normalized);
      return { token: held.token, fingerprint: held.fingerprint };
    },
  );

  /**
   * Sends one request under the host's rate-limit pause and fails a refusal with the error that
   * says why. `onSuccess` sees the answer only once it is known to be one.
   */
  const send = Effect.fn("GitHubApi.send")(function* (input: {
    readonly host: string;
    readonly operation: string;
    readonly request: HttpClientRequest.HttpClientRequest;
    readonly maxResponseBytes: number;
    readonly allowReserve: boolean;
    readonly acceptNotModified: boolean;
    /** GitHub answers a throttled GraphQL document with HTTP 200 and a `RATE_LIMITED` error. */
    readonly graphql?: boolean;
  }) {
    const host = normalizeHost(input.host);
    const { token, fingerprint } = yield* credential(host);
    const scope = yield* SourceControlRateLimit.CredentialScope;
    const key = { provider: "github" as const, host };
    const run = Effect.gen(function* () {
      const lease = yield* limits.check(
        key,
        input.allowReserve ? { allowPaused: true } : undefined,
      );
      const response: HttpClientResponse.HttpClientResponse = yield* httpClient
        .execute(
          input.request.pipe(
            HttpClientRequest.bearerToken(Redacted.value(token)),
            HttpClientRequest.setHeaders({
              "x-github-api-version": API_VERSION,
              "user-agent": "t3code",
            }),
          ),
        )
        .pipe(
          Effect.timeout(DEFAULT_TIMEOUT),
          Effect.mapError(
            (cause) => new GitHubApiRequestError({ host, operation: input.operation, cause }),
          ),
        );
      const collected = yield* collectUint8StreamText({
        stream: response.stream,
        maxBytes: input.maxResponseBytes,
      }).pipe(
        // 204, 304 and many refusals carry no body at all, which is an empty answer, not a failure.
        Effect.catchIf(
          (error) => error.reason._tag === "EmptyBodyError",
          () => Effect.succeed({ text: "", truncated: false }),
        ),
        Effect.mapError(
          (cause) => new GitHubApiRequestError({ host, operation: input.operation, cause }),
        ),
      );
      const headers = response.headers;
      const status = response.status;
      const throttled =
        input.graphql === true &&
        status === 200 &&
        (graphqlErrors(collected.text)?.types.includes("RATE_LIMITED") ?? false);
      if (
        !throttled &&
        ((status >= 200 && status < 300) || (status === 304 && input.acceptNotModified))
      ) {
        yield* limits.recordSuccess({ ...key, lease });
        return { status, headers, body: collected.text, truncated: collected.truncated };
      }
      if (throttled || isRateLimited(status, headers, collected.text)) {
        const retryAt = retryAtFrom(headers, yield* Clock.currentTimeMillis);
        yield* limits.recordRateLimit({ ...key, lease, retryAt });
        return yield* new GitHubApiRateLimitError({
          host,
          operation: input.operation,
          ...(retryAt === undefined ? {} : { retryAt }),
        });
      }
      if (status === 401) {
        // The source may hold a newer token than the one that was refused.
        yield* credentials.invalidate(host);
        return yield* new GitHubApiAuthenticationError({ host, operation: input.operation });
      }
      if (status === 404) {
        return yield* new GitHubApiNotFoundError({ host, operation: input.operation });
      }
      const errors = graphqlErrors(collected.text);
      return yield* new GitHubApiResponseError({
        host,
        operation: input.operation,
        status,
        ...(errors === null ? {} : { graphqlErrors: errors.messages }),
      });
    });
    // The rate-limit scope follows the credential, so a pause on one account never blocks another.
    return yield* gate
      .withPermit(run)
      .pipe(Effect.provideService(SourceControlRateLimit.CredentialScope, scope || fingerprint));
  });

  const rest: GitHubApi["Service"]["rest"] = (input) => {
    const url = `${gitHubApiUrls(input.host).rest}/${input.path.replace(/^\/+/, "")}`;
    const base = HttpClientRequest.make(input.method ?? "GET")(url).pipe(
      HttpClientRequest.setHeader("accept", input.accept ?? "application/vnd.github+json"),
    );
    const withEtag =
      input.ifNoneMatch === undefined
        ? base
        : base.pipe(HttpClientRequest.setHeader("if-none-match", input.ifNoneMatch));
    const request =
      input.body === undefined
        ? withEtag
        : withEtag.pipe(HttpClientRequest.bodyJsonUnsafe(input.body));
    return send({
      host: input.host,
      operation: input.operation,
      request,
      maxResponseBytes: input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      allowReserve: input.allowReserve === true,
      acceptNotModified: input.ifNoneMatch !== undefined,
    });
  };

  const graphql: GitHubApi["Service"]["graphql"] = Effect.fn("GitHubApi.graphql")(
    function* (input) {
      const host = normalizeHost(input.host);
      const { fingerprint } = yield* credential(host);
      const scope = (yield* SourceControlRateLimit.CredentialScope) || fingerprint;
      return yield* Effect.gen(function* () {
        const query = yield* budget.query(
          host,
          input.query,
          input.allowReserve === true ? { allowReserve: true } : undefined,
        );
        const response = yield* send({
          host,
          operation: input.operation,
          request: HttpClientRequest.post(gitHubApiUrls(host).graphql).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyJsonUnsafe({ query, variables: input.variables ?? {} }),
          ),
          maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
          allowReserve: input.allowReserve === true,
          acceptNotModified: false,
          graphql: true,
        });
        yield* budget.observe(host, response.body);
        // GitHub answers a failed GraphQL document with HTTP 200 and an `errors` list. `gh api
        // graphql` fails those, and callers rely on that to fall back to narrower reads.
        const errors = graphqlErrors(response.body);
        if (errors === null) return response.body;
        if (errors.types.length > 0 && errors.types.every((type) => type === "NOT_FOUND")) {
          return yield* new GitHubApiNotFoundError({ host, operation: input.operation });
        }
        return yield* new GitHubApiResponseError({
          host,
          operation: input.operation,
          status: response.status,
          graphqlErrors: errors.messages,
        });
      }).pipe(Effect.provideService(SourceControlRateLimit.CredentialScope, scope));
    },
  );

  return GitHubApi.of({ graphql, rest, credential });
});

export const layer = Layer.effect(GitHubApi, make);

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** The JSON body of a REST answer, or none when GitHub sent nothing (204, 304). */
export function restJson(response: GitHubRestResponse): Option.Option<unknown> {
  return response.body.trim() === "" ? Option.none() : decodeJson(response.body);
}
