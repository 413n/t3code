import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpRouter, HttpServerRequest, HttpServerResponse, UrlParams } from "effect/http";

import * as McpOAuth from "./McpOAuth.ts";
import { renderErrorPage } from "./mcpOAuthHtml.ts";

const PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const page = (html: string, status = 200) =>
  HttpServerResponse.text(html, {
    status,
    contentType: "text/html; charset=utf-8",
    headers: PAGE_HEADERS,
  });

const redirectTo = (url: string) =>
  HttpServerResponse.redirect(url, {
    status: 302,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });

const oauthJson = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });

const badRequest = HttpServerResponse.text("Bad Request", { status: 400 });

const requestUrls = Effect.map(HttpServerRequest.HttpServerRequest, McpOAuth.requestUrls);

/** An unverified client or redirect gets a page; anything else goes back to the client. */
const rejectAuthorization = (
  error: McpOAuth.McpOAuthPageError | McpOAuth.McpOAuthRedirectError,
  issuer: string,
) =>
  error._tag === "McpOAuthPageError"
    ? page(renderErrorPage(error.description), 400)
    : redirectTo(McpOAuth.redirectForError(error, issuer));

const lookup = (params: UrlParams.UrlParams) => (name: string) => {
  const value = Option.getOrUndefined(UrlParams.getFirst(params, name));
  return value === undefined || value.length === 0 ? undefined : value;
};

const protectedResource = Effect.gen(function* () {
  const urls = yield* requestUrls;
  return Option.isNone(urls)
    ? badRequest
    : oauthJson(McpOAuth.protectedResourceMetadata(urls.value));
});

const authorizationServer = Effect.gen(function* () {
  const urls = yield* requestUrls;
  return Option.isNone(urls)
    ? badRequest
    : oauthJson(McpOAuth.authorizationServerMetadata(urls.value));
});

const register = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const oauth = yield* McpOAuth.McpOAuth;
  const body = yield* request.json.pipe(Effect.option);
  if (Option.isNone(body)) {
    return oauthJson(
      { error: "invalid_client_metadata", error_description: "Expected a JSON body." },
      400,
    );
  }
  return yield* oauth.register(body.value).pipe(
    Effect.map((client) =>
      oauthJson(
        {
          client_id: client.clientId,
          client_name: client.name,
          redirect_uris: client.redirectUris,
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
        201,
      ),
    ),
    Effect.catch((error) =>
      Effect.succeed(oauthJson({ error: error.kind, error_description: error.description }, 400)),
    ),
  );
});

/** Where the approval page lives in the web app. */
const APPROVAL_PAGE_PATH = "/connect-agent";

/**
 * The browser lands here from the agent. A valid request is handed to the web
 * app's approval page; a bad client or redirect gets a plain error page and is
 * never redirected, since its redirect URI is unverified.
 */
const authorizeGet = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const oauth = yield* McpOAuth.McpOAuth;
  const url = HttpServerRequest.toURL(request);
  const urls = yield* requestUrls;
  if (Option.isNone(url) || Option.isNone(urls)) return badRequest;
  const authorization = yield* oauth
    .validateAuthorization({
      urls: urls.value,
      params: lookup(UrlParams.fromInput(url.value.searchParams)),
    })
    .pipe(Effect.result);
  if (Result.isFailure(authorization)) {
    return rejectAuthorization(authorization.failure, urls.value.issuer);
  }
  return redirectTo(`${APPROVAL_PAGE_PATH}${url.value.search}`);
});

/** Reads the authorize parameters the approval page forwards, as JSON or a query string. */
const forwardedParams = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body = yield* request.json.pipe(Effect.option);
  if (Option.isNone(body) || typeof body.value !== "object" || body.value === null) {
    return undefined;
  }
  const values = body.value as Record<string, unknown>;
  return (name: string) => {
    const value = values[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
});

const approvalError = (error: string, status = 400) => oauthJson({ error }, status);

/** Validates a forwarded request; an invalid one is reported, never redirected. */
const forwardedAuthorization = (params: (name: string) => string | undefined) =>
  Effect.gen(function* () {
    const oauth = yield* McpOAuth.McpOAuth;
    const urls = yield* requestUrls;
    if (Option.isNone(urls)) return { _tag: "error" as const, response: badRequest };
    const authorization = yield* oauth
      .validateAuthorization({ urls: urls.value, params })
      .pipe(Effect.result);
    if (Result.isFailure(authorization)) {
      const error = authorization.failure;
      return {
        _tag: "error" as const,
        response:
          error._tag === "McpOAuthPageError"
            ? approvalError(error.description)
            : oauthJson({ redirectTo: McpOAuth.redirectForError(error, urls.value.issuer) }),
      };
    }
    return { _tag: "ok" as const, authorization: authorization.success, urls: urls.value };
  });

/** What the approval page shows: who is asking, where the code goes, and whether one click may approve. */
const approvalDetails = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const oauth = yield* McpOAuth.McpOAuth;
  const params = yield* forwardedParams;
  if (params === undefined) return approvalError("Expected the sign-in request.");
  const resolved = yield* forwardedAuthorization(params);
  if (resolved._tag === "error") return resolved.response;
  const session = yield* oauth.approvingBrowserSession(request, resolved.authorization);
  return oauthJson({
    clientName: resolved.authorization.client.name,
    redirectHost: new URL(resolved.authorization.redirectUri).host,
    environmentHost: new URL(resolved.urls.issuer).host,
    ...(session === undefined ? {} : { csrfToken: session.csrfToken }),
  });
});

/** Approves or denies; answers with where the browser goes next. */
const decide = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const oauth = yield* McpOAuth.McpOAuth;
  const params = yield* forwardedParams;
  if (params === undefined) return approvalError("Expected the sign-in request.");
  const resolved = yield* forwardedAuthorization(params);
  if (resolved._tag === "error") return resolved.response;
  if (params("decision") !== "approve") {
    return oauthJson({ redirectTo: oauth.deny(resolved.authorization) });
  }
  const runtimeModeCeiling = Option.getOrUndefined(
    McpOAuth.decodeRuntimeMode(params("runtime_mode")),
  );
  if (runtimeModeCeiling === undefined) return approvalError("Choose what the agent may do.");
  const pairingCode = params("pairing_code");
  const csrfToken = params("csrf_token");
  if (pairingCode === undefined && csrfToken === undefined) {
    return approvalError("Enter a pairing code.");
  }
  return yield* oauth
    .approve({
      request,
      authorization: resolved.authorization,
      runtimeModeCeiling,
      method:
        pairingCode !== undefined
          ? { type: "pairing-code", code: pairingCode }
          : { type: "browser-session", csrfToken: csrfToken! },
    })
    .pipe(
      Effect.map((redirect) => oauthJson({ redirectTo: redirect })),
      Effect.catch((error) => Effect.succeed(approvalError(error.message))),
    );
});

const token = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const oauth = yield* McpOAuth.McpOAuth;
  const urls = yield* requestUrls;
  if (Option.isNone(urls)) return badRequest;
  const form = yield* request.urlParamsBody.pipe(Effect.option);
  if (Option.isNone(form)) {
    return oauthJson({ error: "invalid_request", error_description: "Expected a form body." }, 400);
  }
  return yield* oauth.exchangeCode({ request, urls: urls.value, params: lookup(form.value) }).pipe(
    Effect.map((result) => oauthJson(result)),
    Effect.catch((error) =>
      Effect.succeed(
        oauthJson(
          { error: error.error, error_description: error.description },
          error.error === "invalid_client" ? 401 : 400,
        ),
      ),
    ),
  );
});

/**
 * MCP OAuth discovery, registration, approval and token routes. The service is
 * resolved when the routes are registered, so the layer (not each request)
 * carries the dependency.
 */
export const layerRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const oauth = yield* McpOAuth.McpOAuth;
    const add = (
      method: "GET" | "POST",
      path: `/${string}`,
      handler: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        never,
        HttpServerRequest.HttpServerRequest | McpOAuth.McpOAuth
      >,
    ) => router.add(method, path, handler.pipe(Effect.provideService(McpOAuth.McpOAuth, oauth)));
    yield* add("GET", "/.well-known/oauth-protected-resource", protectedResource);
    yield* add("GET", "/.well-known/oauth-protected-resource/mcp", protectedResource);
    yield* add("GET", "/.well-known/oauth-authorization-server", authorizationServer);
    yield* add("POST", "/oauth/mcp/register", register);
    yield* add("GET", "/oauth/mcp/authorize", authorizeGet);
    yield* add("POST", "/oauth/mcp/approval", approvalDetails);
    yield* add("POST", "/oauth/mcp/decision", decide);
    yield* add("POST", "/oauth/mcp/token", token);
  }),
);
