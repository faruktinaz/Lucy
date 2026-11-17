/**
 * Files that mix languages: HTML (with `<script>` and `<style>`), Vue and Svelte single-file
 * components, and PHP templates. The HTML grammar colors the markup; each embedded block is
 * highlighted on its own with the right language and shifted into place. OpenTUI's worker would
 * need injection queries for this; doing it here keeps the grammars untouched and also serves
 * the diff view.
 */
import type { HighlightOnceResult } from "./lucy-tree-sitter-client";
import type { HighlightRange } from "./types";

export const COMPOSITE_FILETYPES: ReadonlySet<string> = new Set([
  "html",
  "htm",
  "xhtml",
  "vue",
  "svelte",
  "php",
]);

export interface EmbeddedRegion {
  readonly start: number;
  readonly end: number;
  readonly filetype: string;
}

const BLOCK = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
const PHP_REGION = /<\?(?:php\b|=)?[\s\S]*?(?:\?>|$(?![\s\S]))/gi;

function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(String.raw`\b${name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`, "i").exec(attrs);
  return (match?.[1] ?? match?.[2] ?? match?.[3])?.toLowerCase();
}

function scriptFiletype(attrs: string): string | undefined {
  const lang = attribute(attrs, "lang");
  if (lang === "ts" || lang === "typescript") return "typescript";
  if (lang === "tsx") return "typescriptreact";
  if (lang === "jsx") return "javascriptreact";
  if (lang !== undefined && lang !== "js" && lang !== "javascript") return undefined;
  const type = attribute(attrs, "type");
  if (type === undefined || type === "module" || type.endsWith("javascript") || type.endsWith("ecmascript")) {
    return "javascript";
  }
  if (type === "text/typescript") return "typescript";
  if (type.endsWith("json") || type === "importmap" || type === "speculationrules") return "json";
  // Templates (`text/x-template`, Handlebars) and unknown types stay uncolored.
  return undefined;
}

/** `<script>` and `<style>` bodies with the language to highlight them with. */
export function findEmbeddedRegions(content: string): EmbeddedRegion[] {
  const regions: EmbeddedRegion[] = [];
  for (const match of content.matchAll(BLOCK)) {
    const [whole, tag = "", attrs = "", body = ""] = match;
    const start = match.index + whole.indexOf(">") + 1;
    const filetype = tag.toLowerCase() === "style" ? "css" : scriptFiletype(attrs);
    if (filetype && body.trim().length > 0) regions.push({ start, end: start + body.length, filetype });
  }
  return regions;
}

/** PHP code blocks, from `<?php`/`<?=` to `?>` or the end of the file. */
export function findPhpRegions(content: string): EmbeddedRegion[] {
  const regions: EmbeddedRegion[] = [];
  for (const match of content.matchAll(PHP_REGION)) {
    if (match[0].length > 0) {
      // `php-code` names the PHP tokenizer itself; `php` would recurse into this composite.
      regions.push({ start: match.index, end: match.index + match[0].length, filetype: "php-code" });
    }
  }
  return regions;
}

/** Replaces regions with spaces (keeping line breaks and length) so another parser skips them. */
export function maskRegions(content: string, regions: readonly EmbeddedRegion[]): string {
  if (regions.length === 0) return content;
  let out = "";
  let at = 0;
  for (const region of regions) {
    out += content.slice(at, region.start) + content.slice(region.start, region.end).replace(/[^\n]/g, " ");
    at = region.end;
  }
  return out + content.slice(at);
}

/** Svelte blocks (`{#if}`, `{:else}`, `{/each}`, `{@html}`) and Vue/Svelte mustache braces. */
function templateExtras(content: string, filetype: string): HighlightRange[] {
  const out: HighlightRange[] = [];
  if (filetype === "svelte") {
    for (const match of content.matchAll(
      /\{[#:/@](?:if|else|each|await|then|catch|key|html|debug|const|render|snippet)\b/g,
    )) {
      out.push({ start: match.index, end: match.index + match[0].length, group: "keyword" });
    }
  }
  if (filetype === "vue") {
    for (const match of content.matchAll(/\{\{|\}\}/g)) {
      out.push({ start: match.index, end: match.index + 2, group: "punctuation.special" });
    }
  }
  return out;
}

type Highlighter = (content: string, filetype: string) => Promise<HighlightOnceResult>;

/**
 * Highlights a composite file. `markup` highlights HTML with the grammar; `embedded` highlights
 * an extracted block (and may itself be a tokenizer or a grammar).
 */
export async function highlightComposite(
  content: string,
  filetype: string,
  markup: Highlighter,
  embedded: Highlighter,
): Promise<HighlightOnceResult> {
  const php = filetype === "php" ? findPhpRegions(content) : [];
  const regions = [...findEmbeddedRegions(maskRegions(content, php)), ...php];
  const [base, ...parts] = await Promise.all([
    markup(maskRegions(content, php), "html"),
    ...regions.map((region) => embedded(content.slice(region.start, region.end), region.filetype)),
  ]);
  const highlights = [...(base?.highlights ?? [])];
  regions.forEach((region, i) => {
    for (const [start, end, group, meta] of parts[i]?.highlights ?? []) {
      highlights.push(
        meta
          ? [start + region.start, end + region.start, group, meta]
          : [start + region.start, end + region.start, group],
      );
    }
  });
  for (const range of templateExtras(content, filetype))
    highlights.push([range.start, range.end, range.group]);
  // Stable: ties keep the markup-first order, as a single worker pass would.
  highlights.sort((a, b) => a[0] - b[0]);
  if (highlights.length === 0 && base?.error) return { error: base.error };
  return { highlights };
}
