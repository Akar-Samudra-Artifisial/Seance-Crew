// What the page sends to the backend, as plain functions over an `api` with `post`. The only network access is the api
// from useAppApi(); every path comes from ./api.ts.
import { ROUTES } from "./api.js";
import { confirmReducer, initialConfirm, type ConfirmAction, type ConfirmRequest, type ConfirmState } from "./confirmFlow.js";

export interface PostApi {
  post(path: string, body?: unknown): Promise<unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The message to show for a failed call. The SDK throws `AppApiError` (with `status`) whose message is
 * `API <status>: <body text>`; the body of our backend is `{ error: { code, message } }`, so show that message. A path
 * missing from `permissions.api` throws a plain Error synchronously, and its message is shown as it is.
 */
export function errorMessage(err: unknown): string {
  if (!(err instanceof Error) || err.message === "") return "The request failed.";
  const match = /^API (\d{3}):\s*([\s\S]*)$/.exec(err.message);
  if (match === null) return err.message;
  const status = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && isRecord(parsed["error"]) && typeof parsed["error"]["message"] === "string" && parsed["error"]["message"] !== "") {
      return parsed["error"]["message"];
    }
  } catch {
    // Not JSON (for example an HTML 404 from the gateway): fall through to the status.
  }
  if (body === "" || body.startsWith("<") || body.length > 200) return `The request failed (HTTP ${status}).`;
  return `${body} (HTTP ${status})`;
}

/** The path and JSON body of the call a confirmed request makes. `confirm: true` is set only here. */
export function callFor(request: ConfirmRequest): { readonly path: string; readonly body: Record<string, unknown> } {
  switch (request.kind) {
    case "grant":
      return {
        path: ROUTES.grantOp,
        body: { channel: request.channel, agent: request.agent, mode: request.mode, confirm: true, ...(request.inboxId === undefined ? {} : { inboxId: request.inboxId }) },
      };
    case "mode":
      return { path: ROUTES.grantOp, body: { channel: request.channel, agent: request.agent, mode: request.mode, confirm: true } };
    case "exorcise":
      return { path: ROUTES.exorcise, body: { channel: request.channel, agent: request.agent, confirm: true } };
  }
}

export function successMessage(request: ConfirmRequest, result: unknown): string {
  if (request.kind === "exorcise") {
    const closed = isRecord(result) && result["closed"] === true;
    return `Exorcised ${request.agent} from ${request.channel}.${closed ? " The session is closed." : " The server did not report the session as closed yet."}`;
  }
  return `Applied ${request.mode} to ${request.agent} in ${request.channel}.`;
}

export interface ConfirmController {
  state(): ConfirmState;
  /** Open the dialog. Sends nothing. */
  open(request: ConfirmRequest): void;
  /** Close the dialog. Sends nothing. */
  cancel(): void;
  /** The user pressed Confirm: the only path that makes a destructive call. */
  confirm(): Promise<void>;
}

export interface ConfirmControllerDeps {
  readonly api: PostApi;
  readonly onState: (state: ConfirmState) => void;
  /** Called after a successful call, with a message for the user. */
  readonly onSuccess: (message: string, request: ConfirmRequest) => void;
  /** Poll the state right away. */
  readonly refresh: () => void;
}

export function createConfirmController(deps: ConfirmControllerDeps): ConfirmController {
  let current: ConfirmState = initialConfirm;
  const dispatch = (action: ConfirmAction): void => {
    const next = confirmReducer(current, action);
    if (next === current) return;
    current = next;
    deps.onState(current);
  };
  return {
    state: () => current,
    open: (request) => dispatch({ type: "open", request }),
    cancel: () => dispatch({ type: "cancel" }),
    async confirm() {
      if (current.phase !== "confirming" && current.phase !== "failed") return;
      const request = current.request;
      dispatch({ type: "confirm" });
      const { path, body } = callFor(request);
      try {
        const result = await deps.api.post(path, body);
        dispatch({ type: "succeeded" });
        deps.onSuccess(successMessage(request, result), request);
        deps.refresh();
      } catch (err) {
        dispatch({ type: "failed", message: errorMessage(err) });
      }
    },
  };
}

export type SummonOutcome = { readonly ok: true; readonly ready: boolean; readonly message: string } | { readonly ok: false; readonly message: string };

/** Client-side check of the channel field; the backend checks again. */
export function channelError(raw: string): string | null {
  const channel = raw.trim();
  if (channel === "") return "Enter a channel name.";
  if (!channel.startsWith("#") || channel.length < 2) return "A channel name must start with # (for example #fix-bug).";
  return null;
}

export async function submitSummon(api: PostApi, rawChannel: string, rawAgent: string): Promise<SummonOutcome> {
  const problem = channelError(rawChannel);
  if (problem !== null) return { ok: false, message: problem };
  const channel = rawChannel.trim();
  const agent = rawAgent.trim() === "" ? "coder" : rawAgent.trim();
  try {
    const result = await api.post(ROUTES.summon, { channel, ...(agent === "coder" ? {} : { agent }) });
    const ready = isRecord(result) && result["ready"] === true;
    return {
      ok: true,
      ready,
      message: ready ? `${agent} is ready in ${channel}.` : `${agent} is still starting in ${channel} and will appear when ready.`,
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export type DismissOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

export async function submitDismiss(api: PostApi, id: string): Promise<DismissOutcome> {
  try {
    await api.post(ROUTES.inboxDismiss, { id });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}
