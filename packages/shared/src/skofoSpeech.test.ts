import { describe, expect, it } from "vite-plus/test";
import {
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
