import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";

import * as GitHubApi from "./GitHubApi.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubGraphQlBudget from "./githubGraphQlBudget.ts";
import * as SourceControlRateLimit from "./SourceControlRateLimit.ts";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

function harness(respond: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  let tokens = ["first", "second"];
  let invalidations = 0;
  const credentials = Layer.succeed(
    GitHubCredentials.GitHubCredentials,
    GitHubCredentials.GitHubCredentials.of({
      get: (host) =>
        Effect.sync(() => ({
          host,
          token: Redacted.make(tokens[0]!),
          source: "gh" as const,
          fingerprint: `${host}:${tokens[0]}`,
        })),
      invalidate: () =>
        Effect.sync(() => {
          invalidations++;
          tokens = tokens.slice(1);
        }),
    }),
  );
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push(request);
      return Effect.succeed(HttpClientResponse.fromWeb(request, respond(request)));
    }),
  );
  const layer = GitHubApi.layer.pipe(
    Layer.provide(Layer.mergeAll(credentials, http)),
    Layer.provideMerge(GitHubGraphQlBudget.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
  );
  return { layer, requests, invalidations: () => invalidations };
}

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

describe("gitHubApiUrls", () => {
  it("maps github.com, GHE.com and GitHub Enterprise Server", () => {
    expect(GitHubApi.gitHubApiUrls("GitHub.com")).toEqual({
      rest: "https://api.github.com",
      graphql: "https://api.github.com/graphql",
    });
    expect(GitHubApi.gitHubApiUrls("acme.ghe.com").graphql).toBe(
      "https://api.acme.ghe.com/graphql",
    );
    expect(GitHubApi.gitHubApiUrls("git.acme.internal")).toEqual({
      rest: "https://git.acme.internal/api/v3",
      graphql: "https://git.acme.internal/api/graphql",
    });
  });
});

describe("environmentToken", () => {
  it("follows gh's precedence per kind of host", () => {
    const env = { GH_TOKEN: "gh", GITHUB_TOKEN: "github", GH_ENTERPRISE_TOKEN: "ghe" };
    expect(GitHubCredentials.environmentToken("github.com", env)).toBe("gh");
    expect(GitHubCredentials.environmentToken("acme.ghe.com", { GITHUB_TOKEN: "github" })).toBe(
      "github",
    );
    expect(GitHubCredentials.environmentToken("git.acme.internal", env)).toBe("ghe");
    expect(GitHubCredentials.environmentToken("git.acme.internal", { GH_TOKEN: "gh" })).toBeNull();
  });
});

describe("GitHubApi", () => {
  it.effect("sends GraphQL with the token and records the reported budget", () => {
    const { layer, requests } = harness(() =>
      json({
        data: {
          viewer: { login: "julius" },
          rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: "2026-10-05T13:00:00Z" },
        },
      }),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubApi.GitHubApi;
      const body = yield* api.graphql({
        host: "github.com",
        operation: "viewer",
        query: "query { viewer { login } }",
      });
      expect(body).toContain('"login":"julius"');
      expect(requests[0]!.url).toBe("https://api.github.com/graphql");
      expect(requests[0]!.headers.authorization).toBe("Bearer first");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails a GraphQL answer that carries errors, naming GitHub's reason", () => {
    const { layer } = harness(() =>
      json({ data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible" }] }),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubApi;
      const error = yield* Effect.flip(
        api.graphql({ host: "github.com", operation: "detail", query: "query { viewer { id } }" }),
      );
      expect(error._tag).toBe("GitHubApiResponseError");
      expect(error.message).toContain("Resource not accessible");
    }).pipe(Effect.provide(layer));
  });

  it.effect("pauses the host after a GraphQL RATE_LIMITED answer until the reset", () => {
    const reset = Math.floor(NOW / 1000) + 600;
    const { layer, requests } = harness(() =>
      json(
        { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
        { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } },
      ),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubApi.GitHubApi;
      const first = yield* Effect.flip(
        api.graphql({ host: "github.com", operation: "summary", query: "query { viewer { id } }" }),
      );
      expect(first).toMatchObject({ _tag: "GitHubApiRateLimitError", retryAt: reset * 1000 });
      const second = yield* Effect.flip(
        api.rest({ host: "github.com", operation: "stack", path: "repos/acme/web/stacks" }),
      );
      expect(second).toMatchObject({
        _tag: "SourceControlRateLimitPausedError",
        retryAt: reset * 1000,
      });
      expect(requests).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps REST 403 with an exhausted quota to a rate limit, and 304 to an answer", () => {
    let call = 0;
    const { layer } = harness(() =>
      ++call === 1
        ? new Response(null, { status: 304 })
        : json(
            { message: "API rate limit exceeded" },
            {
              status: 403,
              headers: { "retry-after": "60" },
            },
          ),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubApi.GitHubApi;
      const notModified = yield* api.rest({
        host: "github.com",
        operation: "checks",
        path: "repos/acme/web/pulls/7",
        ifNoneMatch: '"abc"',
      });
      expect(notModified.status).toBe(304);
      const error = yield* Effect.flip(
        api.rest({ host: "github.com", operation: "checks", path: "repos/acme/web/pulls/7" }),
      );
      expect(error).toMatchObject({ _tag: "GitHubApiRateLimitError", retryAt: NOW + 60_000 });
    }).pipe(Effect.provide(layer));
  });

  it.effect("drops a refused token so the next request asks the source again", () => {
    const { layer, requests, invalidations } = harness((request) =>
      request.headers.authorization === "Bearer first"
        ? new Response(null, { status: 401 })
        : json({ ok: true }),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubApi;
      const refused = yield* Effect.flip(
        api.rest({ host: "github.com", operation: "user", path: "user" }),
      );
      expect(refused._tag).toBe("GitHubApiAuthenticationError");
      expect(invalidations()).toBe(1);
      const answered = yield* api.rest({ host: "github.com", operation: "user", path: "user" });
      expect(answered.status).toBe(200);
      expect(requests.map((request) => request.headers.authorization)).toEqual([
        "Bearer first",
        "Bearer second",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to send a pinned credential to another host", () => {
    const { layer, requests } = harness(() => json({}));
    return Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubApi;
      const error = yield* Effect.flip(
        api.rest({ host: "git.acme.internal", operation: "user", path: "user" }),
      ).pipe(
        Effect.provideService(GitHubApi.PinnedGitHubCredential, {
          host: "github.com",
          token: Redacted.make("pinned"),
          credentialFingerprint: "github.com:pinned",
        }),
      );
      expect(error._tag).toBe("GitHubApiAuthenticationError");
      expect(requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});
