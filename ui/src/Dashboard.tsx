import { PageHeader } from "@kirocrew/app-sdk/ui";
import { AgentControls } from "./AgentControls.js";
import { ChannelCard } from "./ChannelCard.js";
import { ConfirmDialog, FOCUS_FALLBACK_ID } from "./ConfirmDialog.js";
import { confirmCopy, initialConfirm, type ConfirmState } from "./confirmFlow.js";
import { triggerIdFor } from "./focus.js";
import type { ModeChange } from "./format.js";
import { Inbox } from "./Inbox.js";
import { LiveRegion } from "./LiveRegion.js";
import { NO_NOTICE, type Notice } from "./notice.js";
import { StatTiles } from "./StatTiles.js";
import { StatusBanner } from "./StatusBanner.js";
import { FOCUS_CSS, SCOPE_ATTR, styles } from "./styles.js";
import { SummaryCard } from "./SummaryCard.js";
import { SummonForm, type SummonMessage } from "./SummonForm.js";
import type { AgentView, InboxView, PollStatus, State, Summary } from "./types.js";
import { EmptyState, Panel, SectionHeader, Skeleton, SrOnly } from "./ui.js";

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

export const CHANNEL_PLACEHOLDERS = 2;

/**
 * The page body: a slim status line, the overview tiles, then two columns that wrap on narrow widths: channels on the
 * left, and on the right what needs action first (Needs op), then Summon and the daily summary.
 */
export function Dashboard({ state, summary, status, actions = IDLE_ACTIONS, announcement = NO_NOTICE, notice = NO_NOTICE }: DashboardProps) {
  const dialog = actions.confirm;
  const copy = dialog.phase === "idle" ? null : confirmCopy(dialog.request);
  // While the confirmed request is on its way, the controls that opened it are aria-disabled.
  const inFlight = dialog.phase === "submitting" ? dialog.request : null;
  const grantingId = inFlight?.kind === "grant" ? (inFlight.inboxId ?? null) : null;
  return (
    <div {...{ [SCOPE_ATTR]: "" }}>
      <style>{FOCUS_CSS}</style>
      <PageHeader title="Séance Crew" subtitle="Channels, agents, credits and permission requests." />
      <main style={styles.page}>
        <LiveRegion announcement={announcement} notice={notice} />
        <StatusBanner bridge={state?.bridge ?? null} status={status} />
        {notice.text === "" ? null : <p style={styles.text}>{notice.text}</p>}
        <StatTiles state={state} />
        <div style={styles.columns}>
          <div style={styles.mainColumn}>
            <Panel labelledBy={FOCUS_FALLBACK_ID}>
              <SectionHeader icon="hash" title="Channels" id={FOCUS_FALLBACK_ID} focusable count={state?.channels.length} />
              {state === null ? (
                <>
                  <SrOnly>Loading channels…</SrOnly>
                  {Array.from({ length: CHANNEL_PLACEHOLDERS }, (_, i) => (
                    <Skeleton key={i} height="12rem" />
                  ))}
                </>
              ) : state.channels.length === 0 ? (
                <EmptyState icon="ghost" title="No channels yet" hint="Summon an agent into a channel whose name starts with #, e.g. #fix-bug" />
              ) : (
                state.channels.map((channel) => (
                  <ChannelCard
                    key={channel.name}
                    channel={channel}
                    now={state.serverTime}
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
            </Panel>
          </div>
          <aside aria-label="Actions and summary" style={styles.aside}>
            {state === null ? null : <Inbox items={state.inbox} now={state.serverTime} grantingId={grantingId} {...actions.inbox} />}
            <SummonForm {...actions.summon} />
            <SummaryCard summary={summary} liveTotal={state?.totalCredits} today={state === null ? undefined : new Date(state.serverTime).toISOString().slice(0, 10)} />
          </aside>
        </div>
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
          triggerId={triggerIdFor(dialog.request)}
          destructive={copy.destructive}
        />
      )}
    </div>
  );
}
