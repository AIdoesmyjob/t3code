import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  CommanderVoiceReply,
  commanderReplyForMessage,
  extractLeadingSpokenBrief,
  extractSpokenBrief,
  splitIntoSpokenSentences,
  stripMarkdownForSpeech,
  stripSpokenTagsForDisplay,
} from "./skofoSpeech.ts";

describe("skofoSpeech", () => {
  it("strips markdown formatting, links, code blocks, SHAs, paths, and emojis into clean prose", () => {
    const input = [
      "### Live Status",
      "- **5 machines** online at [t3.skofo.ca](https://t3.skofo.ca) (`bf91c76008`).",
      "- Config saved at /home/monstrcow/.local/share/t3code/config.json and https://example.com/logs.",
      "```bash",
      "systemctl status t3code",
      "```",
      "Ready for instructions. 🚀",
    ].join("\n");

    const cleaned = stripMarkdownForSpeech(input);
    expect(cleaned).not.toContain("https://");
    expect(cleaned).not.toContain("systemctl");
    expect(cleaned).not.toContain("bf91c76008");
    expect(cleaned).not.toContain("/home/monstrcow");
    expect(cleaned).not.toContain("🚀");
    expect(cleaned).toContain("5 machines online at t3.skofo.ca");
    expect(cleaned).toContain("Ready for instructions.");
  });

  it("replaces entire markdown tables with a concise on-screen cue", () => {
    const input = [
      "Fleet overview:",
      "| Host | Status | VMs |",
      "| --- | --- | --- |",
      "| albert | online | 12 |",
      "| david | online | 18 |",
      "| louis | online | 10 |",
      "All systems nominal.",
    ].join("\n");

    const cleaned = stripMarkdownForSpeech(input);
    expect(cleaned).not.toContain("albert");
    expect(cleaned).not.toContain("david");
    expect(cleaned).toContain("The table is on screen.");
    expect(cleaned).toContain("All systems nominal.");
  });

  it("prefers explicit <!-- spoken: ... --> briefs over verbose tables and strips tags for display", () => {
    const reply = [
      "| Service | State |",
      "| --- | --- |",
      "| t3code | active |",
      "| voice | active |",
      "",
      "<!-- spoken: Both T3 Code and the voice service are online with zero errors. The full table is on screen. -->",
    ].join("\n");

    expect(extractSpokenBrief(reply)).toBe(
      "Both T3 Code and the voice service are online with zero errors. The full table is on screen.",
    );
    expect(splitIntoSpokenSentences(reply, { mode: "auto" })).toEqual([
      "Both T3 Code and the voice service are online with zero errors.",
      "The full table is on screen.",
    ]);
    expect(stripSpokenTagsForDisplay(reply)).not.toContain("<!-- spoken:");
    expect(stripSpokenTagsForDisplay(reply)).toContain("| Service | State |");
    expect(
      stripSpokenTagsForDisplay("Status ready.\n<!-- spoken: Halfway through stre", {
        isStreaming: true,
      }),
    ).toBe("Status ready.");
  });

  it("extracts a completed leading brief before its Markdown finishes streaming", () => {
    expect(extractLeadingSpokenBrief("  <!-- spoken: Fleet ready. -->\n\n| Service")).toBe(
      "Fleet ready.",
    );
    expect(extractLeadingSpokenBrief("<!-- spoken: Fleet ready.")).toBeNull();
    expect(extractLeadingSpokenBrief("<!-- spoken:    -->")).toBeNull();
    expect(extractLeadingSpokenBrief("Status.\n<!-- spoken: Fleet ready. -->")).toBeNull();
  });

  it("hides split spoken openers while retaining comparisons and other comments", () => {
    for (const prefix of ["<", "<!", "<!-", "<!--", "<!-- s", "<!-- SPOKEN ", "<!-- spoken: abc"]) {
      expect(stripSpokenTagsForDisplay(prefix, { isStreaming: true })).toBe("");
      expect(stripSpokenTagsForDisplay(`Status.\n${prefix}`, { isStreaming: true })).toBe(
        "Status.",
      );
    }
    expect(stripSpokenTagsForDisplay("Limit: 3 < 4", { isStreaming: true })).toBe("Limit: 3 < 4");
    expect(stripSpokenTagsForDisplay("3 <", { isStreaming: true })).toBe("3 <");
    expect(stripSpokenTagsForDisplay("<!-- other", { isStreaming: true })).toBe("<!-- other");
  });

  it("returns a concise cue when the message contains only a code block", () => {
    expect(splitIntoSpokenSentences("```ts\nconst x = 1;\n```")).toEqual([
      "Code output is ready in the thread.",
    ]);
  });

  it("splits multi-sentence replies cleanly without breaking versions or domains", () => {
    const input =
      "Release 0.1.11 is live on t3.skofo.ca right now. Four threads are actively running with zero errors. Would you like me to inspect Book Keeper next?";
    const sentences = splitIntoSpokenSentences(input);
    expect(sentences).toEqual([
      "Release 0.1.11 is live on t3.skofo.ca right now.",
      "Four threads are actively running with zero errors.",
      "Would you like me to inspect Book Keeper next?",
    ]);
  });

  it("uses concise auto limits when no spoken tag is present", () => {
    const longText = Array.from(
      { length: 8 },
      (_, idx) => `Sentence number ${idx + 1} reports healthy operational status across the fleet.`,
    ).join(" ");
    const autoSentences = splitIntoSpokenSentences(longText, { mode: "auto" });
    expect(autoSentences).toHaveLength(4);
    expect(autoSentences.at(-1)).toBe("Full details are in the thread.");
  });
});

describe("Commander voice reply correlation", () => {
  it("ignores watcher and other-client runs even when they are newer", () => {
    const voice = {
      id: RunId.make("voice"),
      userMessageId: MessageId.make("my-voice"),
      status: "running",
    } as const;
    const runs = [
      voice,
      { id: RunId.make("watch"), userMessageId: MessageId.make("wake"), status: "completed" },
      {
        id: RunId.make("other"),
        userMessageId: MessageId.make("other-client"),
        status: "completed",
      },
    ] as const;
    const threadId = ThreadId.make("computer");
    const now = DateTime.makeUnsafe("2026-11-22T12:00:00Z");
    const rows = runs.map((run, ordinal): OrchestrationV2ProjectedTurnItem => {
      const id = TurnItemId.make(`assistant-${run.id}`);
      return {
        position: ordinal,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: id,
        item: {
          id,
          threadId,
          runId: run.id,
          ordinal,
          type: "assistant_message",
          phase: "final_answer",
          messageId: MessageId.make(`reply-${run.id}`),
          text: `Reply from ${run.id}`,
          streaming: run.status === "running",
          status: run.status,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          title: null,
          startedAt: now,
          updatedAt: now,
          completedAt: null,
        },
      };
    });
    expect(commanderReplyForMessage(runs, rows, "my-voice")).toEqual({
      run: voice,
      item: rows[0]?.item,
    });
    expect(commanderReplyForMessage(runs, rows, "absent")).toBeNull();
  });

  it("claims the leading brief once and holds the mic until its run settles", () => {
    const reply = new CommanderVoiceReply("my-voice");
    const running = { status: "running" };
    const completed = { status: "completed" };
    expect(reply.observe(running, "<!-- spoken: Four threads")).toBeNull();
    expect(reply.observe(running, "<!-- spoken: Four threads. -->")).toEqual({
      type: "speak",
      text: "Four threads.",
    });
    expect(reply.observe(running, "<!-- spoken: Four threads. -->\nDetails")).toBeNull();
    expect(reply.finishAudio("completed")).toBe(false);
    expect(reply.observe(completed, "<!-- spoken: Four threads. -->\nDetails")).toEqual({
      type: "listen",
    });
  });

  it("falls back on completion and settles empty, failed and cancelled runs", () => {
    const reply = new CommanderVoiceReply("my-voice");
    expect(reply.observe({ status: "running" }, "More to come.")).toBeNull();
    expect(reply.observe({ status: "completed" }, "Ready.")).toEqual({
      type: "speak",
      text: "Ready.",
    });
    expect(reply.observe({ status: "completed" }, "Ready.")).toBeNull();
    expect(reply.finishAudio("completed")).toBe(true);
    for (const [status, type] of [
      ["completed", "empty"],
      ["failed", "failed"],
      ["cancelled", "failed"],
    ]) {
      expect(new CommanderVoiceReply("next").observe({ status: status! }, " ")).toEqual({ type });
    }
  });
});
