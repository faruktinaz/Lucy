/**
 * Log files: timestamps, severity levels, quoted strings, numbers, URLs, `key=value` keys and
 * exception names. Levels use the `comment.error`, `comment.warning` and `comment.note` groups,
 * which map to the `error`, `warning` and `info` tokens; debug and trace levels are dimmed.
 * Lower-case level words count only in a level position (`[error]`, `level=warn`), so ordinary
 * prose such as "no error found" stays plain.
 */
import type { HighlightRange } from "../types";

interface Rule {
  readonly pattern: RegExp;
  readonly group: string | ((match: string) => string);
  /** Which first characters the rule can match: digits, letters or quotes. */
  readonly starts: "digit" | "letter" | "quote";
}

function levelGroup(word: string): string {
  const level = word.toLowerCase();
  if (/^(?:fatal|critical|crit|error|err|emerg|alert|severe|panic)$/.test(level)) return "comment.error";
  if (/^(?:warn|warning)$/.test(level)) return "comment.warning";
  if (/^(?:info|notice)$/.test(level)) return "comment.note";
  return "comment";
}

const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";

/** Tried in order at every position; the first match wins. */
const RULES: readonly Rule[] = [
  {
    pattern: new RegExp(
      [
        String.raw`\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?`,
        String.raw`\d{4}/\d{2}/\d{2}(?: \d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?)?`,
        String.raw`\d{2}/(?:${MONTHS})/\d{4}:\d{2}:\d{2}:\d{2}(?: [+-]\d{4})?`,
        String.raw`\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?`,
      ].join("|"),
      "y",
    ),
    group: "type",
    starts: "digit",
  },
  {
    pattern: new RegExp(String.raw`(?:${MONTHS}) {1,2}\d{1,2} \d{2}:\d{2}:\d{2}`, "y"),
    group: "type",
    starts: "letter",
  },
  {
    pattern:
      /\b(?:FATAL|CRITICAL|CRIT|ERROR|ERR|EMERG|ALERT|SEVERE|PANIC|WARNING|WARN|INFO|NOTICE|DEBUG|TRACE|VERBOSE)\b/y,
    group: levelGroup,
    starts: "letter",
  },
  {
    pattern:
      /(?<=\[|\blevel[=:]\s?"?|"level"\s*:\s*")(?:fatal|critical|crit|error|err|warn|warning|info|notice|debug|trace)\b/iy,
    group: levelGroup,
    starts: "letter",
  },
  { pattern: /\b[\w.$]*(?:Exception|Error)\b/y, group: "comment.error", starts: "letter" },
  { pattern: /https?:\/\/[^\s"'<>)\]]+/y, group: "string.special.url", starts: "letter" },
  { pattern: /"(?:[^"\\\n]|\\.)*"/y, group: "string", starts: "quote" },
  { pattern: /(?<![\w'])'[^'\n]*'(?![\w])/y, group: "string", starts: "quote" },
  { pattern: /[\p{L}_][\p{L}\p{N}_.-]*(?==)/uy, group: "property", starts: "letter" },
  { pattern: /(?<![\p{L}\p{N}_.])\d+(?:\.\d+)*(?![\p{L}_])/uy, group: "number", starts: "digit" },
];

const WORD = /[\p{L}\p{N}_]+/uy;

export function tokenizeLog(text: string): HighlightRange[] {
  const out: HighlightRange[] = [];
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 10 || code === 32 || code === 9 || code === 13) {
      i++;
      continue;
    }
    const starts = code >= 48 && code <= 57 ? "digit" : code === 34 || code === 39 ? "quote" : "letter";
    let matched = false;
    for (const rule of RULES) {
      if (rule.starts !== starts) continue;
      rule.pattern.lastIndex = i;
      const match = rule.pattern.exec(text);
      if (!match || match[0].length === 0) continue;
      const group = typeof rule.group === "string" ? rule.group : rule.group(match[0]);
      out.push({ start: i, end: i + match[0].length, group });
      i += match[0].length;
      matched = true;
      break;
    }
    if (matched) continue;
    // Skip a whole word at once so no rule fires inside it.
    WORD.lastIndex = i;
    const word = WORD.exec(text);
    i += word ? word[0].length : 1;
  }
  return out;
}
