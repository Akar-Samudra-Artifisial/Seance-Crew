import { PageHeader, StatCard } from "@kirocrew/app-sdk/ui";
import { AgentControls } from "./AgentControls.js";
import { ChannelCard } from "./ChannelCard.js";
import { ConfirmDialog, FOCUS_FALLBACK_ID } from "./ConfirmDialog.js";
import { confirmCopy, initialConfirm, type ConfirmState } from "./confirmFlow.js";
import { formatCredits, type ModeChange } from "./format.js";
import { Inbox } from "./Inbox.js";
import { LiveRegion } from "./LiveRegion.js";
import { NO_NOTICE, type Notice } from "./notice.js";
import { StatusBanner } from "./StatusBanner.js";
import { styles } from "./styles.js";
import { SummaryCard } from "./SummaryCard.js";
import { SummonForm, type SummonMessage } from "./SummonForm.js";
import type { AgentView, InboxView, PollStatus, State, Summary } from "./types.js";

/** Everything the page can do, as callbacks, so the page body stays free of hooks and renders to static markup. */
export interface DashboardActions {
  readonly summon: {
    readonly channel: string;
    readonly agent: string;
    readonly pending: boolean;
    readonly message: SummonMessage | null;
    readonly onChange: (field: "channel" | "agent", value: string) => void;
    readonly onSubmit: () => void;
  };
  readonly inbox: {
    readonly pendingId: string | null;
    readonly errors: Readonly<Record<string, string>>;
    readonly onGrant: (item: InboxView, channel: string) => void;
    readonly onDismiss: (item: InboxView) => void;
  };
  readonly onMode: (agent: AgentView, channel: string, mode: ModeChange) => void;
  readonly onExorcise: (agent: AgentView, channel: string) => void;
  readonly confirm: ConfirmState;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

const noop = (): void => undefined;

/** Actions that do nothing: the default for tests that only look at the markup. */
export const IDLE_ACTIONS: DashboardActions = {
  summon: { channel: "", agent: "", pending: false, message: null, onChange: noop, onSubmit: noop },
  inbox: { pendingId: null, errors: {}, onGrant: noop, onDismiss: noop },
  onMode: noop,
  onExorcise: noop,
  confirm: initialConfirm,
  onConfirm: noop,
  onCancel: noop,
};

export interface DashboardProps {
  readonly state: State | null;
  readonly summary: Summary | null | undefined;
  readonly status: PollStatus | null;
  readonly actions?: DashboardActions;
  /** Text for the aria-live region (new commits, new inbox items). */
  readonly announcement?: Notice;
  /** Visible result of the last action; also announced. */
  readonly notice?: Notice;
}

/** The page body. */
export function Dashboard({ state, summary, status, actions = IDLE_ACTIONS, announcement = NO_NOTICE, notice = NO_NOTICE }: DashboardProps) {
  const dialog = actions.confirm;
  const copy = dialog.phase === "idle" ? null : confirmCopy(dialog.request);
  // While the confirmed request is on its way, the controls that opened it are aria-disabled.
  const inFlight = dialog.phase === "submitting" ? dialog.request : null;
  const grantingId = inFlight?.kind === "grant" ? (inFlight.inboxId ?? null) : null;
  return (
    <>
      <PageHeader title="Séance Crew" subtitle="Channels, agents, credits and permission requests." />
      <main style={styles.page}>
        <LiveRegion announcement={announcement} notice={notice} />
        <StatusBanner bridge={state?.bridge ?? null} status={status} />
        {notice.text === "" ? null : <p style={styles.text}>{notice.text}</p>}
        <section aria-label="Totals">
          <StatCard label="Total credits" value={formatCredits(state?.totalCredits)} />
        </section>
        <SummaryCard summary={summary} />
        <SummonForm {...actions.summon} />
        {state === null ? null : <Inbox items={state.inbox} now={state.serverTime} grantingId={grantingId} {...actions.inbox} />}
        <section aria-labelledby={FOCUS_FALLBACK_ID}>
          <h2 id={FOCUS_FALLBACK_ID} tabIndex={-1} style={styles.heading}>
            Channels
          </h2>
          {state === null ? (
            <p style={styles.text}>Loading channels…</p>
          ) : state.channels.length === 0 ? (
            <p style={styles.text}>No channels yet. To start one, summon an agent into a channel whose name starts with # (for example #fix-bug).</p>
          ) : (
            state.channels.map((channel) => (
              <ChannelCard
                key={channel.name}
                channel={channel}
                agentControls={(agent, ch) => (
                  <AgentControls
                    agent={agent}
                    channel={ch.name}
                    onMode={actions.onMode}
                    onExorcise={actions.onExorcise}
                    busy={inFlight !== null && inFlight.channel === ch.name && inFlight.agent === agent.nick}
                  />
                )}
              />
            ))
          )}
          {state?.truncated === true ? <p style={styles.hint}>Some older log lines were left out to keep the page fast.</p> : null}
        </section>
      </main>
      {copy === null || dialog.phase === "idle" ? null : (
        <ConfirmDialog
          title={copy.title}
          body={copy.body}
          confirmLabel={copy.confirmLabel}
          busy={dialog.phase === "submitting"}
          error={dialog.phase === "failed" ? dialog.message : null}
          onConfirm={actions.onConfirm}
          onCancel={actions.onCancel}
        />
      )}
    </>
  );
}
