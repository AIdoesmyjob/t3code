import remarkParse from "remark-parse";
import { unified } from "unified";

import { markdownDestinationHostPath, safeDecodeURIComponent } from "./markdownLinks.ts";
import { parseFileUrlHref } from "./fileLinks.ts";
import { remarkKeepWindowsPaths } from "./markdownWindowsPaths.ts";
import { chatMarkdownImageSources } from "./markdownPipeline.ts";
import {
  isUncPath,
  isWindowsDrivePath,
  normalizeProjectPathForComparison,
  stripSlashPrefixedWindowsDrive,
} from "./path.ts";

const parser = unified().use(remarkParse).use(remarkKeepWindowsPaths);

interface MarkdownNode {
  readonly type: string;
  readonly url?: string | undefined;
  readonly identifier?: string | undefined;
  readonly label?: string | null | undefined;
  readonly alt?: string | null | undefined;
  readonly title?: string | null | undefined;
  readonly position?:
    | {
        readonly start: { readonly offset?: number | undefined };
        readonly end: { readonly offset?: number | undefined };
      }
    | undefined;
  readonly children?: ReadonlyArray<MarkdownNode> | undefined;
}

function imageDestination(path: string): string {
  return isWindowsDrivePath(path)
    ? path.replaceAll("\\", "/")
    : isUncPath(path)
      ? `file:${path.replaceAll("\\", "/")}`
      : path;
}

// Backslashes left after Windows conversion belong to POSIX names, where Markdown would read them
// as escapes; line breaks end an angle destination.
function angleDestination(path: string): string {
  return `<${path.replace(/[%?#&\\\r\n]/g, encodeURIComponent).replace(/[<>]/g, "\\$&")}>`;
}

function rewriteSavedImageDestinations(
  text: string,
  destinations: ReadonlyMap<string, string>,
): string {
  const definitions = new Map<string, MarkdownNode>();
  const images: Array<MarkdownNode> = [];
  const visit = (node: MarkdownNode) => {
    if (
      node.type === "definition" &&
      node.identifier !== undefined &&
      !definitions.has(node.identifier)
    ) {
      definitions.set(node.identifier, node);
    } else if (node.type === "image" || node.type === "imageReference") {
      images.push(node);
    }
    node.children?.forEach(visit);
  };
  const nodes = parser.parse(text).children;
  nodes.forEach(visit);
  const edits = new Map<number, { readonly end: number; readonly text: string }>();
  for (const image of images) {
    const target = image.type === "image" ? image : definitions.get(image.identifier ?? "");
    if (target?.url === undefined) continue;
    // Literal percent sequences may be file names, so raw paths take precedence over decoding.
    // Protect file URL delimiters so parsing does not discard literal query/hash characters.
    const file = /^file:/i.test(target.url)
      ? parseFileUrlHref(target.url.replace(/[%?#]/g, encodeURIComponent))
      : null;
    const rawPath = stripSlashPrefixedWindowsDrive(
      file === null ? target.url : safeDecodeURIComponent(file.path),
    );
    const path = [rawPath, safeDecodeURIComponent(rawPath)].find((candidate) =>
      destinations.has(normalizeProjectPathForComparison(candidate)),
    );
    if (path === undefined) continue;
    const destination = angleDestination(imageDestination(path));
    const start = target.position?.start.offset;
    const end = target.position?.end.offset;
    if (
      (imageDestination(target.url) !== target.url ||
        /[?#]/.test(target.url) ||
        (path === rawPath && path.includes("%"))) &&
      start !== undefined &&
      end !== undefined
    ) {
      const label =
        target.type === "image" ? (target.alt ?? "") : (target.label ?? target.identifier ?? "");
      const escapedLabel = label.replace(/[\\[\]]/g, "\\$&");
      const definitionLabel = /^ {0,3}\[(?:\\.|[^\\\]])*\]:/s.exec(text.slice(start, end))?.[0];
      const title = target.title == null ? "" : ` "${target.title.replace(/["\\]/g, "\\$&")}"`;
      edits.set(start, {
        end,
        text:
          target.type === "image"
            ? `![${escapedLabel}](${destination}${title})`
            : `${definitionLabel ?? `[${escapedLabel}]:`} ${destination}${title}`,
      });
    }
  }
  let result = text;
  for (const [start, edit] of Array.from(edits).sort(([left], [right]) => right - left)) {
    result = result.slice(0, start) + edit.text + result.slice(edit.end);
  }
  return result;
}

function imageEmbed(path: string): string {
  return `![](${angleDestination(imageDestination(path))})`;
}

// An unclosed fence or raw HTML block swallows the rest of the reply. Only a root-level block
// can swallow appended embeds; nested ones end with their container.
function unclosedBlockEnd(text: string): string | undefined {
  const last = parser.parse(text).children.at(-1);
  const source = text.slice(last?.position?.start.offset, last?.position?.end.offset);
  if (last?.type === "html") {
    const tag = /^ {0,3}<(script|pre|style|textarea)(?=[\s>]|$)/i.exec(source)?.[1];
    if (tag !== undefined) {
      return /<\/(?:script|pre|style|textarea)>/i.test(source) ? undefined : `</${tag}>`;
    }
    return /^ {0,3}<!--/.test(source) && !source.includes("-->") ? "-->" : undefined;
  }
  if (last?.type !== "code") return undefined;
  const fence = /^ {0,3}(`{3,}|~{3,})/.exec(source)?.[1];
  if (fence === undefined) return undefined;
  const lines = source.split(/\r\n|\r|\n/);
  const closing = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(lines.at(-1) ?? "")?.[1];
  const closed =
    lines.length > 1 &&
    closing !== undefined &&
    closing[0] === fence[0] &&
    closing.length >= fence.length;
  return closed ? undefined : fence;
}

/** Appends an embed for each saved image the reply does not already show. */
export function appendGeneratedImageEmbeds(text: string, savedPaths: Iterable<string>): string {
  const destinations = new Map(
    Array.from(savedPaths, (path) => [normalizeProjectPathForComparison(path), path]),
  );
  text = rewriteSavedImageDestinations(text, destinations);
  const shown = new Set(
    chatMarkdownImageSources(text).flatMap((source) => {
      const path = markdownDestinationHostPath(source);
      return path === null ? [] : [normalizeProjectPathForComparison(path)];
    }),
  );
  const missing = new Map<string, string>();
  for (const path of destinations.values()) {
    const key = normalizeProjectPathForComparison(path);
    if (!shown.has(key) && !missing.has(key)) missing.set(key, path);
  }
  if (missing.size === 0) return text;
  const end = unclosedBlockEnd(text);
  let result = end === undefined ? text : `${text}${/[\r\n]$/.test(text) ? "" : "\n"}${end}`;
  for (const path of missing.values()) {
    result += `${result.length > 0 ? "\n\n" : ""}${imageEmbed(path)}`;
  }
  return result;
}
