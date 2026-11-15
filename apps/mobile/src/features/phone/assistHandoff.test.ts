import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fake = vi.hoisted(() => ({
  queued: [] as Array<{ messageId: string }>,
  listeners: [] as Array<() => void>,
  appState: "active",
  activeThread: { environmentId: "env", threadId: "thread" } as {
    environmentId: string;
    threadId: string;
  } | null,
  moveToBackground: vi.fn(() => true),
}));

vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return fake.appState;
    },
    addEventListener: () => ({ remove: () => {} }),
  },
}));
vi.mock("../../native/phoneControl", () => ({
  phoneControlNative: { moveToBackground: fake.moveToBackground },
}));
vi.mock("../sharing/IncomingShareProvider", () => ({ addIncomingTextDraft: vi.fn() }));
vi.mock("../../lib/appState", () => ({ subscribeAppActive: () => () => {} }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "uuid" }));
vi.mock("../../lib/rootNavigation", () => ({
  rootNavigationRef: { isReady: () => true, getRootState: () => ({}) },
}));
vi.mock("../shortcuts/appShortcuts", () => ({ activeThreadRef: () => fake.activeThread }));
vi.mock("../../state/thread-outbox", () => ({
  threadOutboxManager: { queuedMessagesByThreadKeyAtom: "queued" },
  flattenQueuedThreadMessages: (queued: unknown) => queued,
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: () => fake.queued,
    subscribe: (_atom: unknown, listener: () => void) => {
      fake.listeners.push(listener);
      return () => {
        fake.listeners = fake.listeners.filter((entry) => entry !== listener);
      };
    },
  },
}));

import { assistDraftText, isAssistShareId, leaveAfterAssistSend } from "./assistHandoff";

const MESSAGE = { messageId: "m1", environmentId: "env", threadId: "thread" };

function deliver() {
  fake.queued = [];
  for (const listener of fake.listeners) listener();
}

describe("assistHandoff", () => {
  beforeEach(() => {
    fake.queued = [{ messageId: "m1" }];
    fake.listeners = [];
    fake.appState = "active";
    fake.activeThread = { environmentId: "env", threadId: "thread" };
    fake.moveToBackground.mockClear();
  });

  it("leads a spoken request with the phone", () => {
    expect(assistDraftText("  turn on wifi ")).toBe("On my phone: turn on wifi");
    expect(assistDraftText("")).toBe("On my phone: ");
  });

  it("recognizes only its own draft ids", () => {
    expect(isAssistShareId("assist-1234")).toBe(true);
    expect(isAssistShareId("share-abc")).toBe(false);
    expect(isAssistShareId(undefined)).toBe(false);
  });

  it("steps aside only once the message is delivered", () => {
    leaveAfterAssistSend(MESSAGE);
    expect(fake.moveToBackground).not.toHaveBeenCalled();
    deliver();
    expect(fake.moveToBackground).toHaveBeenCalledTimes(1);
    expect(fake.listeners).toHaveLength(0);
  });

  it("stays when the owner has moved to another screen", () => {
    leaveAfterAssistSend(MESSAGE);
    fake.activeThread = null;
    deliver();
    expect(fake.moveToBackground).not.toHaveBeenCalled();
  });

  it("stays when the app is no longer in front", () => {
    leaveAfterAssistSend(MESSAGE);
    fake.appState = "background";
    deliver();
    expect(fake.moveToBackground).not.toHaveBeenCalled();
  });
});
