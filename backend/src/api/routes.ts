// /api/*: the dashboard's JSON API. Every request passes, in this order:
//   1. the shared local-caller guard (Host 421, Origin 403)
//   2. the gateway's X-KiroCrew-Proxy signature (503 when KIROCREW_PROXY_SECRET is unset, 403 when it does not verify)
//   3. routing (404 unknown path, 405 wrong method), then the content-type and JSON checks for POST
// Unknown paths are answered only after the signature check, so an unsigned caller learns nothing about the route table.
import type http from "node:http";
import { checkLocalCaller } from "../http/guard.js";
import { pathnameOf, sendJson, type Route } from "../http.js";
import type { Store } from "../irc/store.js";
import type { ToolRegistry, SummaryProvider } from "../mcp/types.js";
import { dismissInbox, exorcise, grantOp, summon, type ApiOutcome } from "./actions.js";
import { MAX_BODY_BYTES, readBodyBytes, sendError } from "./http-util.js";
import { PROXY_HEADER, ReplayGuard, verifyProxyRequest } from "./proxyAuth.js";
import { BOOT_ID, buildState, type StateBridge } from "./state.js";

export const API_PREFIX = "/api";

export interface ApiDeps {
  /** The port the server listens on (known only after listen, hence a function). */
  readonly port: () => number;
  /** KIROCREW_GATEWAY_ORIGIN. */
  readonly gatewayOrigin: string | undefined;
  /** KIROCREW_PROXY_SECRET, read at request time. Unset or empty means every /api/* request is a 503. */
  readonly proxySecret: () => string | undefined;
  readonly store: Store;
  readonly bridge: StateBridge;
  readonly registry: ToolRegistry;
  readonly summary?: SummaryProvider;
  readonly now: () => number;
  /** Remembers used POST signatures; createApiRoute adds one when it is absent. */
  readonly replay?: ReplayGuard;
}

type Method = "GET" | "POST";

interface ApiRoute {
  readonly method: Method;
  readonly path: string;
  readonly handle: (deps: ApiDeps, ctx: { readonly url: URL; readonly body: unknown }) => Promise<ApiOutcome> | ApiOutcome;
}

const ok = (body: unknown): ApiOutcome => ({ status: 200, body });
const invalid = (code: string, message: string): ApiOutcome => ({ status: 422, body: { error: { code, message } } });

/** The implemented routes. `app.json` permissions.api must list exactly these paths (checked by a test). */
export const API_ROUTES: readonly ApiRoute[] = [
  {
    method: "GET",
    path: "/api/state",
    handle: (deps, { url }) => {
      const raw = url.searchParams.get("since");
      let since: number | null = null;
      if (raw !== null) {
        if (!/^[0-9]{1,15}$/.test(raw)) return invalid("invalid_since", "since must be a non-negative integer revision.");
        since = Number(raw);
      }
      if (since !== null && since === deps.store.revision) return ok({ changed: false, revision: since, bootId: BOOT_ID });
      return ok(buildState(deps.store, deps.bridge));
    },
  },
  {
    method: "GET",
    path: "/api/summary",
    handle: (deps) => ok({ summary: deps.summary?.latest() ?? null }),
  },
  { method: "POST", path: "/api/summon", handle: (deps, { body }) => summon(deps, body) },
  { method: "POST", path: "/api/grant-op", handle: (deps, { body }) => grantOp(deps, body) },
  { method: "POST", path: "/api/exorcise", handle: (deps, { body }) => exorcise(deps, body) },
  { method: "POST", path: "/api/inbox/dismiss", handle: (deps, { body }) => dismissInbox(deps, body) },
];

export const API_PATHS: readonly string[] = API_ROUTES.map((r) => r.path);

const isJsonContentType = (value: string | undefined): boolean => value !== undefined && /^application\/json\s*(;|$)/i.test(value.trim());

export async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, deps: ApiDeps): Promise<void> {
  // 1. Who is calling? Before anything else, and before the body is read.
  const guard = checkLocalCaller(req, { port: deps.port(), gatewayOrigin: deps.gatewayOrigin });
  if (!guard.ok) {
    sendError(res, guard.status, guard.code, guard.code === "bad_host" ? "Host header not allowed." : "Origin not allowed.", { Connection: "close" });
    return;
  }
  // 2. Fail closed without a secret; do not read the body of a request that cannot be verified.
  const secret = deps.proxySecret();
  if (secret === undefined || secret === "") {
    sendError(res, 503, "proxy_secret_missing", "The app has no proxy secret, so /api/* is closed.");
    return;
  }
  const tooLarge = (): void => {
    sendError(res, 413, "payload_too_large", `The request body is larger than ${MAX_BODY_BYTES} bytes.`, { Connection: "close" });
    res.once("finish", () => req.destroy());
  };
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    tooLarge();
    return;
  }
  const bodyBytes = await readBodyBytes(req);
  if (bodyBytes === null) {
    tooLarge();
    return;
  }
  const header = req.headers[PROXY_HEADER];
  const verdict = verifyProxyRequest({
    header: typeof header === "string" ? header : undefined,
    method: req.method ?? "",
    target: req.url ?? "",
    body: bodyBytes,
    secret,
    nowMs: deps.now(),
  });
  if (!verdict.ok) {
    sendError(res, verdict.status, verdict.code, verdict.code === "proxy_secret_missing" ? "The app has no proxy secret, so /api/* is closed." : "Missing or invalid gateway signature.");
    return;
  }
  // A signed POST can be used once: the same header again within 120 s is a replay. (GETs are idempotent, and the same
  // poll legitimately repeats within one second, so only POSTs are tracked.)
  if (req.method === "POST" && typeof header === "string" && deps.replay !== undefined && !deps.replay.accept(header, deps.now())) {
    sendError(res, 403, "replayed_signature", "This signed request was already used.");
    return;
  }
  // 3. Routing.
  const pathname = pathnameOf(req.url);
  const matching = API_ROUTES.filter((r) => r.path === pathname);
  if (matching.length === 0) {
    sendError(res, 404, "not_found", "No such API path.");
    return;
  }
  const route = matching.find((r) => r.method === req.method);
  if (route === undefined) {
    sendError(res, 405, "method_not_allowed", "Method not allowed.", { Allow: matching.map((r) => r.method).join(", ") });
    return;
  }
  let body: unknown;
  if (route.method === "POST") {
    if (!isJsonContentType(req.headers["content-type"])) {
      sendError(res, 400, "bad_content_type", "Content-Type must be application/json.");
      return;
    }
    try {
      body = JSON.parse(bodyBytes.toString("utf8")) as unknown;
    } catch {
      sendError(res, 400, "bad_json", "The request body is not valid JSON.");
      return;
    }
  }
  const outcome = await route.handle(deps, { url: new URL(req.url ?? "/", "http://127.0.0.1"), body });
  sendJson(res, outcome.status, outcome.body);
}

/** The route object for src/http.ts. Unexpected throws are logged by the router and answered with 500. */
export function createApiRoute(deps: ApiDeps): Route {
  const withReplay: ApiDeps = { ...deps, replay: deps.replay ?? new ReplayGuard() };
  return { prefix: API_PREFIX, handle: (req, res) => handleApi(req, res, withReplay) };
}
