import { subscribeAppActive } from "../../lib/appState";
import { uuidv4 } from "../../lib/uuid";
import { phoneControlNative } from "../../native/phoneControl";
import { addIncomingTextDraft } from "../sharing/IncomingShareProvider";

const ASSIST_SHARE_PREFIX = "assist-";
const PHONE_REQUEST_LEAD = "On my phone:";
/** Long enough for the thread outbox to hand the first message to the server. */
const LEAVE_AFTER_SEND_MS = 1_500;

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

/**
 * After a spoken request is sent, gets out of the way: the T3 app is off limits to phone
 * control, so staying in front would block the agent's first command.
 */
export function leaveAfterAssistSend(): void {
  const native = phoneControlNative;
  if (!native) return;
  setTimeout(() => native.moveToBackground(), LEAVE_AFTER_SEND_MS);
}
