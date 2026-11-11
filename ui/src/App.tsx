import { useAppApi } from "@kirocrew/app-sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { createConfirmController, submitDismiss, submitSummon, type PostApi } from "./actions.js";
import { initialConfirm, type ConfirmState } from "./confirmFlow.js";
import { Dashboard, type DashboardActions } from "./Dashboard.js";
import { applyFocus, focusCandidates } from "./focus.js";
import { createNoticeManager, NO_NOTICE, type Notice } from "./notice.js";
import type { SummonMessage } from "./SummonForm.js";
import type { InboxView, State } from "./types.js";
import { useSeanceState } from "./useSeanceState.js";

/** How long to wait for a new state before moving focus anyway. */
const FOCUS_WAIT_MS = 6_000;

export default function App() {
  const api = useAppApi();
  const apiRef = useRef(api);
  apiRef.current = api;
  const { state, summary, status, announcement, refresh } = useSeanceState();
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  // The one network access of the page: the SDK's api, through the gateway proxy.
  const [postApi] = useState<PostApi>(() => ({ post: (path, body) => apiRef.current.post(path, body) }));

  const [form, setForm] = useState({ channel: "", agent: "" });
  const [summonPending, setSummonPending] = useState(false);
  const [summonMessage, setSummonMessage] = useState<SummonMessage | null>(null);
  const [notice, setNotice] = useState<Notice>(NO_NOTICE);
  // One manager: shows a message for 5 s, then clears it; a repeated message gets a new id and is announced again.
  const [notices] = useState(() => createNoticeManager(setNotice));
  useEffect(() => () => notices.stop(), [notices]);
  const [confirm, setConfirm] = useState<ConfirmState>(initialConfirm);
  const [dismissPending, setDismissPending] = useState<string | null>(null);
  const [dismissErrors, setDismissErrors] = useState<Readonly<Record<string, string>>>({});

  // After a successful action its trigger is replaced (Give +o -> Revoke -o) or gone (exorcise); once the new state has
  // rendered, move focus to the replacement control, the agent row or the channel card heading instead of <body>.
  const stateRef = useRef(state);
  stateRef.current = state;
  const pendingFocus = useRef<{ readonly ids: readonly string[]; readonly from: State | null } | null>(null);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleFocus = useCallback((last: boolean) => {
    const pending = pendingFocus.current;
    if (pending === null) return;
    // Focus still on a real element (for example the old trigger, not yet replaced): wait for the next state.
    if (!last && document.activeElement !== null && document.activeElement !== document.body) return;
    pendingFocus.current = null;
    if (focusTimer.current !== null) clearTimeout(focusTimer.current);
    focusTimer.current = null;
    applyFocus(document, pending.ids);
  }, []);
  useEffect(() => {
    if (pendingFocus.current !== null && state !== pendingFocus.current.from) settleFocus(false);
  }, [state, settleFocus]);
  useEffect(() => () => {
    if (focusTimer.current !== null) clearTimeout(focusTimer.current);
  }, []);

  const [controller] = useState(() =>
    createConfirmController({
      api: postApi,
      onState: setConfirm,
      onSuccess: (message, request) => {
        notices.show(message);
        pendingFocus.current = { ids: focusCandidates(request), from: stateRef.current };
        if (focusTimer.current !== null) clearTimeout(focusTimer.current);
        // If no new state arrives (nothing changed), still settle focus after a while.
        focusTimer.current = setTimeout(() => settleFocus(true), FOCUS_WAIT_MS);
      },
      refresh: () => refreshRef.current(),
    }),
  );

  const onSummon = useCallback(async () => {
    setSummonPending(true);
    setSummonMessage(null);
    const outcome = await submitSummon(postApi, form.channel, form.agent);
    setSummonPending(false);
    // A failure keeps the field values so the user can fix them and try again.
    setSummonMessage({ ok: outcome.ok, text: outcome.message });
    if (outcome.ok) refreshRef.current();
  }, [postApi, form.channel, form.agent]);

  const onDismiss = useCallback(
    async (item: InboxView) => {
      setDismissPending(item.id);
      setDismissErrors(({ [item.id]: _cleared, ...rest }) => rest);
      const outcome = await submitDismiss(postApi, item.id);
      setDismissPending(null);
      if (outcome.ok) {
        notices.show(`Dismissed the request from ${item.agent}.`);
        refreshRef.current();
      } else {
        setDismissErrors((errors) => ({ ...errors, [item.id]: outcome.message }));
      }
    },
    [postApi, notices],
  );

  const actions: DashboardActions = {
    summon: {
      channel: form.channel,
      agent: form.agent,
      pending: summonPending,
      message: summonMessage,
      onChange: (field, value) => setForm((f) => ({ ...f, [field]: value })),
      onSubmit: () => void onSummon(),
    },
    inbox: {
      pendingId: dismissPending,
      errors: dismissErrors,
      onGrant: (item, channel) => controller.open({ kind: "grant", channel, agent: item.agent, mode: "+o", inboxId: item.id }),
      onDismiss: (item) => void onDismiss(item),
    },
    onMode: (agent, channel, mode) => controller.open({ kind: "mode", channel, agent: agent.nick, mode }),
    onExorcise: (agent, channel) => controller.open({ kind: "exorcise", channel, agent: agent.nick }),
    confirm,
    onConfirm: () => void controller.confirm(),
    onCancel: () => controller.cancel(),
  };

  return <Dashboard state={state} summary={summary} status={status} actions={actions} announcement={announcement} notice={notice} />;
}
