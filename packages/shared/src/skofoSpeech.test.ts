import { describe, expect, it } from "vite-plus/test";
import { splitIntoSpokenSentences, stripMarkdownForSpeech } from "./skofoSpeech.ts";

describe("skofoSpeech", () => {
  it("strips markdown formatting, links, code blocks, and emojis into clean prose", () => {
    const input = [
      "### Live Status",
      "- **5 machines** online at [t3.skofo.ca](https://t3.skofo.ca).",
      "- Visit https://example.com/logs for raw logs.",
      "```bash",
      "systemctl status t3code",
      "```",
      "Ready for instructions. 🚀",
    ].join("\n");

    const cleaned = stripMarkdownForSpeech(input);
    expect(cleaned).not.toContain("https://");
    expect(cleaned).not.toContain("systemctl");
    expect(cleaned).not.toContain("🚀");
    expect(cleaned).toContain("5 machines online at t3.skofo.ca.");
    expect(cleaned).toContain("Ready for instructions.");
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

  it("caps very long responses and appends a short thread pointer", () => {
    const longText = Array.from(
      { length: 12 },
      (_, idx) => `Sentence number ${idx + 1} reports healthy operational status across the fleet.`,
    ).join(" ");
    const sentences = splitIntoSpokenSentences(longText, { maxSentences: 3 });
    expect(sentences).toHaveLength(4);
    expect(sentences.at(-1)).toBe("Full details are in the thread.");
  });
});
