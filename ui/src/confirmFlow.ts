// The confirm flow for destructive actions, as a pure reducer. Nothing is sent unless the flow reaches "submitting",
// which only the user's explicit confirm can cause.

export type ConfirmRequest =
  /** Grant +o to an agent that asked for it (an inbox item). */
  | { readonly kind: "grant"; readonly channel: string; readonly agent: string; readonly mode: "+o"; readonly inboxId?: string }
  /** Change an agent's mode from the mode control. */
  | { readonly kind: "mode"; readonly channel: string; readonly agent: string; readonly mode: "+v" | "-v" | "+o" | "-o" }
  | { readonly kind: "exorcise"; readonly channel: string; readonly agent: string };

export type ConfirmState =
  | { readonly phase: "idle" }
  | { readonly phase: "confirming"; readonly request: ConfirmRequest }
  | { readonly phase: "submitting"; readonly request: ConfirmRequest }
  | { readonly phase: "failed"; readonly request: ConfirmRequest; readonly message: string };

export type ConfirmAction =
  | { readonly type: "open"; readonly request: ConfirmRequest }
  | { readonly type: "cancel" }
  | { readonly type: "confirm" }
  | { readonly type: "succeeded" }
  | { readonly type: "failed"; readonly message: string };

export const initialConfirm: ConfirmState = { phase: "idle" };

export function confirmReducer(state: ConfirmState, action: ConfirmAction): ConfirmState {
  switch (action.type) {
    case "open":
      // One dialog at a time; a request in flight is not replaced.
      return state.phase === "submitting" ? state : { phase: "confirming", request: action.request };
    case "cancel":
      // Cancelling never sends; a submit already on its way cannot be cancelled.
      return state.phase === "submitting" ? state : initialConfirm;
    case "confirm":
      // Retrying after a failure also needs a fresh confirm click.
      return state.phase === "confirming" || state.phase === "failed" ? { phase: "submitting", request: state.request } : state;
    case "succeeded":
      return state.phase === "submitting" ? initialConfirm : state;
    case "failed":
      return state.phase === "submitting" ? { phase: "failed", request: state.request, message: action.message } : state;
  }
}

export interface ConfirmCopy {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
}

const MODE_EFFECT: Record<"+v" | "-v" | "+o" | "-o", string> = {
  "+v": "+v lets the agent speak in the channel.",
  "-v": "-v takes away the agent's voice.",
  "+o": "+o lets the agent edit files and run commands in the channel worktree.",
  "-o": "-o takes away the agent's right to edit files and run commands.",
};

export function confirmCopy(request: ConfirmRequest): ConfirmCopy {
  switch (request.kind) {
    case "grant":
    case "mode":
      return {
        title: request.mode.startsWith("-")
          ? `Revoke ${request.mode} from ${request.agent} in ${request.channel}?`
          : `Grant ${request.mode} to ${request.agent} in ${request.channel}?`,
        body: MODE_EFFECT[request.mode],
        confirmLabel: `Apply ${request.mode} to ${request.agent} in ${request.channel}`,
      };
    case "exorcise":
      return {
        title: `Exorcise ${request.agent} from ${request.channel}?`,
        body: "The agent stops and uncommitted work in the worktree is reverted.",
        confirmLabel: `Exorcise ${request.agent} from ${request.channel}`,
      };
  }
}

/** Index of the element to focus next inside a trapped dialog. `index` -1 means focus is outside the dialog. */
export function nextFocusIndex(count: number, index: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (index < 0) return backwards ? count - 1 : 0;
  return backwards ? (index - 1 + count) % count : (index + 1) % count;
}
