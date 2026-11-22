/**
 * Utilities for turning assistant markdown replies into concise, natural spoken sentences
 * for Skofo Computer voice playback across web and mobile clients.
 */

const FULL_MAX_SENTENCES = 8;
const FULL_MAX_CHARS = 1_100;
const AUTO_MAX_SENTENCES = 3;
const AUTO_MAX_CHARS = 420;
const SPOKEN_TAG_MAX_SENTENCES = 6;
const SPOKEN_TAG_MAX_CHARS = 700;
const MIN_FRAGMENT_CHARS = 24;

const COMPLETED_SPOKEN_TAG_RE = /<!--\s*spoken\s*:([\s\S]*?)-->/gi;
const STREAMING_SPOKEN_TAG_RE = /<!--\s*spoken\s*:[\s\S]*?(?:-->|$)/gi;

/**
 * Extracts explicit concise spoken text embedded by Computer via `<!-- spoken: ... -->`.
 */
export function extractSpokenBrief(markdown: string): string | null {
  const parts: string[] = [];
  for (const match of markdown.matchAll(COMPLETED_SPOKEN_TAG_RE)) {
    const inner = match[1]?.replace(/\s+/g, " ").trim();
    if (inner) parts.push(inner);
  }
  if (parts.length === 0) return null;
  return parts.join(" ").trim();
}

/**
 * Strips `<!-- spoken: ... -->` metadata comments from markdown before rendering in chat UI,
 * including partial unclosed tags while an assistant reply is still streaming.
 */
export function stripSpokenTagsForDisplay(
  markdown: string,
  options?: { readonly isStreaming?: boolean },
): string {
  const pattern = options?.isStreaming ? STREAMING_SPOKEN_TAG_RE : COMPLETED_SPOKEN_TAG_RE;
  if (!markdown.includes("<!--")) return markdown;
  return markdown.replace(pattern, "").trimEnd();
}

function stripMarkdownTables(input: string): string {
  const lines = input.split(/\r?\n/);
  const output: string[] = [];
  let sawTable = false;
  let i = 0;

  const isPipeRow = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    const pipeCount = (trimmed.match(/\|/g) ?? []).length;
    return pipeCount >= 2 || (trimmed.startsWith("|") && trimmed.endsWith("|"));
  };
  const isSeparatorRow = (line: string) => /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(line);

  while (i < lines.length) {
    const current = lines[i] ?? "";
    const next = lines[i + 1] ?? "";
    // Standard GFM table: header row + separator row + 0+ body rows
    if (isPipeRow(current) && isSeparatorRow(next)) {
      i += 2;
      while (i < lines.length && isPipeRow(lines[i] ?? "")) {
        i += 1;
      }
      if (!sawTable) {
        output.push("The table is on screen.");
        sawTable = true;
      }
      continue;
    }
    // Standalone separator row or 2+ consecutive pipe-delimited rows
    if (isSeparatorRow(current)) {
      i += 1;
      continue;
    }
    if (isPipeRow(current) && isPipeRow(next)) {
      while (i < lines.length && isPipeRow(lines[i] ?? "")) {
        i += 1;
      }
      if (!sawTable) {
        output.push("The table is on screen.");
        sawTable = true;
      }
      continue;
    }
    output.push(current);
    i += 1;
  }
  return output.join("\n");
}

export function stripMarkdownForSpeech(markdown: string): string {
  const trimmed = markdown.trim();
  if (!trimmed) return "";

  // Drop HTML comments (including spoken tags)
  const withoutComments = trimmed.replace(/<!--[\s\S]*?-->/g, " ");
  const withoutFences = withoutComments.replace(/```[\s\S]*?```/g, " ");
  const hasOnlyCode = withoutFences.trim().length === 0;
  if (hasOnlyCode) {
    return "Code output is ready in the thread.";
  }

  let text = stripMarkdownTables(withoutFences);
  // Convert markdown images ![alt](url) -> empty, markdown links [label](url) -> label
  text = text.replace(/!\[[^\]]*\]\([^)]+\)/g, " ");
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Drop raw URLs
  text = text.replace(/https?:\/\/\S+/g, " ");
  // Unwrap inline code ticks
  text = text.replace(/`([^`]+)`/g, "$1");
  // Drop long hex git commit SHAs (7-40 hex chars containing both letters and digits)
  text = text.replace(
    /\b(?=[0-9a-f]{7,40}\b)(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/gi,
    "",
  );
  // Drop raw absolute POSIX paths (e.g. /home/monstrcow/dev/...)
  text = text.replace(/(?:^|\s)\/(?:home|Users|var|etc|tmp|opt|usr)\/\S+/g, " ");
  // Convert markdown list markers & headings into sentence breaks so bullet lists read cleanly
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*+•]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  // Strip remaining markdown formatting tokens
  text = text.replace(/[*_~>|]+/g, " ");
  // Strip astral emoji / pictographs
  text = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ");
  // Clean empty parentheses left behind after stripping SHAs/paths/URLs
  text = text.replace(/\(\s*[,;:-]*\s*\)/g, " ");
  // Turn line breaks that do not already end with sentence punctuation into period breaks
  const lines = text
    .split(/\r?\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0 && !/^[.,;:!?-]+$/.test(line));

  const normalizedLines = lines.map((line) => (/[.!?…:]$/.test(line) ? line : `${line}.`));

  return normalizedLines
    .join(" ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitIntoSpokenSentences(
  markdown: string,
  options?: {
    readonly mode?: "auto" | "full";
    readonly maxSentences?: number;
    readonly maxChars?: number;
  },
): ReadonlyArray<string> {
  const explicitBrief = extractSpokenBrief(markdown);
  const clean = explicitBrief
    ? stripMarkdownForSpeech(explicitBrief)
    : stripMarkdownForSpeech(markdown);
  if (!clean) return [];

  const mode = options?.mode ?? "full";
  const maxSentences =
    options?.maxSentences ??
    (explicitBrief
      ? SPOKEN_TAG_MAX_SENTENCES
      : mode === "auto"
        ? AUTO_MAX_SENTENCES
        : FULL_MAX_SENTENCES);
  const maxChars =
    options?.maxChars ??
    (explicitBrief ? SPOKEN_TAG_MAX_CHARS : mode === "auto" ? AUTO_MAX_CHARS : FULL_MAX_CHARS);

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

  if (truncated && !explicitBrief) {
    selected.push("Full details are in the thread.");
  }

  return selected;
}
