/**
 * Utilities for turning assistant markdown replies into concise, natural spoken sentences
 * for Skofo Computer voice playback across web and mobile clients.
 */

const DEFAULT_MAX_SENTENCES = 8;
const DEFAULT_MAX_CHARS = 1_100;
const MIN_FRAGMENT_CHARS = 24;

export function stripMarkdownForSpeech(markdown: string): string {
  const trimmed = markdown.trim();
  if (!trimmed) return "";

  const withoutFences = trimmed.replace(/```[\s\S]*?```/g, " ");
  const hasOnlyCode = withoutFences.trim().length === 0;
  if (hasOnlyCode) {
    return "Code output is ready in the thread.";
  }

  let text = withoutFences;
  // Drop markdown tables (header separator rows + pipe rows)
  text = text.replace(/^\s*\|?[\s:-]+\|[\s|:-]*$/gm, " ");
  // Convert markdown images ![alt](url) -> empty, markdown links [label](url) -> label
  text = text.replace(/!\[[^\]]*\]\([^)]+\)/g, " ");
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Drop raw URLs
  text = text.replace(/https?:\/\/\S+/g, " ");
  // Unwrap inline code ticks
  text = text.replace(/`([^`]+)`/g, "$1");
  // Convert markdown list markers & headings into sentence breaks so bullet lists read cleanly
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*+•]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  // Strip remaining markdown formatting tokens
  text = text.replace(/[*_~>|]+/g, " ");
  // Strip astral emoji / pictographs
  text = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ");
  // Turn line breaks that do not already end with sentence punctuation into period breaks
  const lines = text
    .split(/\r?\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);

  const normalizedLines = lines.map((line) => (/[.!?…:]$/.test(line) ? line : `${line}.`));

  return normalizedLines.join(" ").replace(/\s+/g, " ").trim();
}

export function splitIntoSpokenSentences(
  markdown: string,
  options?: { readonly maxSentences?: number; readonly maxChars?: number },
): ReadonlyArray<string> {
  const clean = stripMarkdownForSpeech(markdown);
  if (!clean) return [];

  const maxSentences = options?.maxSentences ?? DEFAULT_MAX_SENTENCES;
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;

  // Split on sentence-ending punctuation followed by whitespace and a likely new sentence start,
  // avoiding splits inside decimals (3.14), versions (0.1.11), domains (t3.skofo.ca), or short abbreviations.
  const rawParts: string[] = [];
  let start = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    const next = clean[i + 1];
    if (next !== undefined && !/\s/.test(next)) continue;

    // Avoid splitting after common abbreviations or single-letter initials
    const before = clean.slice(Math.max(start, i - 6), i + 1);
    if (ch === "." && /(?:^|\s)(?:Mr|Mrs|Ms|Dr|St|vs|e\.g|i\.e|etc|[A-Za-z])\.$/i.test(before)) {
      continue;
    }

    const candidate = clean.slice(start, i + 1).trim();
    if (candidate.length > 0) {
      rawParts.push(candidate);
    }
    start = i + 1;
    while (start < clean.length && /\s/.test(clean[start] ?? "")) start += 1;
  }
  const tail = clean.slice(start).trim();
  if (tail.length > 0) rawParts.push(tail);

  // Merge tiny fragments with neighbor so TTS cadence stays smooth
  const merged: string[] = [];
  for (const part of rawParts) {
    const prev = merged.at(-1);
    if (
      prev !== undefined &&
      (prev.length < MIN_FRAGMENT_CHARS || part.length < MIN_FRAGMENT_CHARS)
    ) {
      if (prev.length + 1 + part.length <= 240) {
        merged[merged.length - 1] = `${prev} ${part}`;
        continue;
      }
    }
    merged.push(part);
  }

  // Enforce character and sentence budget cleanly
  const selected: string[] = [];
  let totalChars = 0;
  let truncated = false;
  for (const sentence of merged) {
    if (selected.length >= maxSentences) {
      truncated = true;
      break;
    }
    if (selected.length > 0 && totalChars + sentence.length > maxChars) {
      truncated = true;
      break;
    }
    selected.push(sentence);
    totalChars += sentence.length;
  }

  if (truncated) {
    selected.push("Full details are in the thread.");
  }

  return selected;
}
