import { AppState } from "react-native";

import { subscribeAppActive } from "../../lib/appState";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { uuidv4 } from "../../lib/uuid";
import { phoneControlNative } from "../../native/phoneControl";
import { appAtomRegistry } from "../../state/atom-registry";
import { flattenQueuedThreadMessages, threadOutboxManager } from "../../state/thread-outbox";
import { addIncomingTextDraft } from "../sharing/IncomingShareProvider";
import { activeThreadRef } from "../shortcuts/appShortcuts";

const ASSIST_SHARE_PREFIX = "assist-";
const PHONE_REQUEST_LEAD = "On my phone:";

/** The draft text for a spoken request; the lead tells the agent the phone is the place to act. */
export function assistDraftText(spoken: string): string {
  const request = spoken.trim();
  return request.length > 0 ? `${PHONE_REQUEST_LEAD} ${request}` : `${PHONE_REQUEST_LEAD} `;
}

export function isAssistShareId(shareId: string | undefined): boolean {
  return shareId?.startsWith(ASSIST_SHARE_PREFIX) ?? false;
}

function takeAssistRequest(): void {
  const request = phoneControlNative?.takeAssistRequest();
  if (!request) return;
  void addIncomingTextDraft({
    id: `${ASSIST_SHARE_PREFIX}${uuidv4()}`,
    text: assistDraftText(request.text),
  }).catch((error: unknown) => {
    console.warn("[assist] could not open the spoken request", error);
  });
}

/**
 * App-lifetime: the long-press-power assistant leaves its spoken request in native memory;
 * picks it up at launch, on resume and when the assistant fires while the app runs.
 */
export function installAssistHandoff(): () => void {
  const native = phoneControlNative;
  if (!native) return () => {};
  takeAssistRequest();
  const unsubscribeActive = subscribeAppActive(takeAssistRequest);
  const subscription = native.addListener("onAssist", takeAssistRequest);
  return () => {
    unsubscribeActive();
    subscription.remove();
  };
}

/** Delivery normally takes seconds; past this the app stays put rather than leave a task unsent. */
const LEAVE_DEADLINE_MS = 60_000;

/**
 * After a spoken request is sent, gets out of the way once the server has the message: the
 * T3 app is off limits to phone control, so staying in front would block the agent's first
 * command. Only while the owner is still on that thread with the app in front; leaving it,
 * backgrounding the app or a slow delivery cancels.
 */
export function leaveAfterAssistSend(message: {
  readonly messageId: string;
  readonly environmentId: string;
  readonly threadId: string;
}): void {
  const native = phoneControlNative;
  if (!native) return;
  let done = false;
  const onSubmittedThread = () => {
    const state = rootNavigationRef.isReady() ? rootNavigationRef.getRootState() : undefined;
    const active = state ? activeThreadRef(state) : null;
    return active?.environmentId === message.environmentId && active.threadId === message.threadId;
  };
  const stillQueued = () =>
    flattenQueuedThreadMessages(
      appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
    ).some((queued) => queued.messageId === message.messageId);
  const stop = () => {
    done = true;
    unsubscribe();
    appState.remove();
    clearTimeout(deadline);
  };
  const check = () => {
    if (done || stillQueued()) return;
    stop();
    if (AppState.currentState === "active" && onSubmittedThread()) native.moveToBackground();
  };
  const unsubscribe = appAtomRegistry.subscribe(
    threadOutboxManager.queuedMessagesByThreadKeyAtom,
    check,
  );
  const appState = AppState.addEventListener("change", (next) => {
    if (next !== "active") stop();
  });
  const deadline = setTimeout(stop, LEAVE_DEADLINE_MS);
  check();
}
