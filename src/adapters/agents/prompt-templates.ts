/**
 * Prompt templates: data plus pure functions that build text for the agent's input box.
 *
 * The built text is only ever PASTED into the agent (see `AgentSessionManager.pastePrompt`),
 * never submitted: the user reviews it and presses Enter. Built prompts never end with a newline.
 *
 * Files are referenced with Claude Code `@path` mentions so the agent reads the current file
 * itself. Paths containing whitespace are quoted (`@"my file.ts"`) and selections add a line range
 * (`@src/a.ts#L10-20`), the form Claude Code's IDE integrations insert. Both forms should be
 * confirmed against the Claude Code version in use; they are not exercised by tests here.
 */
import { LucyError } from "@/core/errors";
import { sanitizeForDisplay } from "@/core/text";

export type PromptTemplateId = "explain" | "review-diff" | "write-tests" | "fix-diagnostics";

export interface PromptSelection {
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** The selected text, included verbatim (fenced) when it is small. */
  text?: string;
}

export interface PromptDiagnostic {
  message: string;
  /** 1-based. */
  line?: number;
  column?: number;
  severity?: "error" | "warning" | "info" | "hint";
  source?: string;
  code?: string | number;
}

export interface PromptContext {
  /** Workspace-relative path, forward slashes. */
  filePath?: string;
  selection?: PromptSelection;
  diagnostics?: readonly PromptDiagnostic[];
  /** Fence language for included code, e.g. "ts". */
  language?: string;
  /** Review only staged changes. */
  staged?: boolean;
}

export type PromptRequirement = "filePath" | "selection" | "diagnostics";

export interface PromptTemplate {
  id: PromptTemplateId;
  label: string;
  description: string;
  requires: readonly PromptRequirement[];
  build(context: PromptContext): string;
}

const MAX_INLINE_SELECTION = 6000;
const MAX_DIAGNOSTICS = 50;

/** One display-safe line: no control characters, no line breaks. */
function line(value: string): string {
  return sanitizeForDisplay(value.replace(/\s+/g, " ").trim());
}

/** Multi-line code: normalized line endings, no control characters except tab and newline. */
function code(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
  return value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function fenced(text: string, language = ""): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${line(language)}\n${code(text).replace(/\n+$/, "")}\n${fence}`;
}

function validRange(selection: PromptSelection | undefined): selection is PromptSelection {
  return (
    selection !== undefined &&
    Number.isInteger(selection.startLine) &&
    Number.isInteger(selection.endLine) &&
    selection.startLine >= 1 &&
    selection.endLine >= selection.startLine
  );
}

/** `@path`, `@"path with spaces"`, optionally with `#Lstart-end`. */
export function formatFileMention(path: string, selection?: PromptSelection): string {
  const clean = line(path);
  const range = validRange(selection)
    ? `#L${selection.startLine}${selection.endLine > selection.startLine ? `-${selection.endLine}` : ""}`
    : "";
  return /\s|"/.test(clean) ? `@"${clean.replace(/"/g, '\\"')}${range}"` : `@${clean}${range}`;
}

function shellQuote(path: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

function lines(selection: PromptSelection): string {
  return selection.endLine > selection.startLine
    ? `lines ${selection.startLine}-${selection.endLine}`
    : `line ${selection.startLine}`;
}

function requireFile(context: PromptContext): string {
  if (!context.filePath?.trim()) throw new LucyError("INVALID_ARGUMENT", "This prompt needs a file");
  return context.filePath;
}

function formatDiagnostic(diagnostic: PromptDiagnostic): string {
  const position =
    diagnostic.line !== undefined
      ? `L${diagnostic.line}${diagnostic.column !== undefined ? `:${diagnostic.column}` : ""} `
      : "";
  const origin = [diagnostic.source, diagnostic.code]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return `- ${position}${diagnostic.severity ?? "error"}${origin ? ` [${line(String(origin))}]` : ""}: ${line(diagnostic.message)}`;
}

export const PROMPT_TEMPLATES: readonly PromptTemplate[] = [
  {
    id: "explain",
    label: "Explain file/selection",
    description: "Ask the agent to explain the current file or the selected lines.",
    requires: ["filePath"],
    build(context) {
      const file = requireFile(context);
      const selection = context.selection;
      if (!validRange(selection)) {
        return `Explain what ${formatFileMention(file)} does: its purpose, its main parts and how they fit together.`;
      }
      let prompt = `Explain what the code in ${formatFileMention(file, selection)} (${lines(selection)}) does, step by step. Point out anything surprising or risky.`;
      if (selection.text && selection.text.length <= MAX_INLINE_SELECTION && selection.text.trim()) {
        prompt += `\n\n${fenced(selection.text, context.language)}`;
      }
      return prompt;
    },
  },
  {
    id: "review-diff",
    label: "Review diff",
    description: "Ask the agent to review uncommitted (or staged) changes without editing.",
    requires: [],
    build(context) {
      const scope = context.staged ? "staged" : "uncommitted";
      const file = context.filePath?.trim() ? context.filePath : undefined;
      const command = `git diff${context.staged ? " --staged" : ""}${file ? ` -- ${shellQuote(line(file))}` : ""}`;
      return (
        `Review my ${scope} changes${file ? ` to ${formatFileMention(file)}` : ""} (run \`${command}\` to see them). ` +
        "Look for bugs, unhandled edge cases, missing tests and risky changes. " +
        "Do not modify any files yet: list your findings ordered by severity."
      );
    },
  },
  {
    id: "write-tests",
    label: "Write tests",
    description: "Ask the agent to write tests for the current file or selection.",
    requires: ["filePath"],
    build(context) {
      const file = requireFile(context);
      const selection = validRange(context.selection) ? context.selection : undefined;
      return (
        `Write tests for ${formatFileMention(file, selection)}${selection ? ` (focus on ${lines(selection)})` : ""}. ` +
        "Follow the project's existing test framework and conventions, cover edge cases and failure paths, " +
        "and run the tests when you are done."
      );
    },
  },
  {
    id: "fix-diagnostics",
    label: "Fix diagnostics",
    description: "Ask the agent to fix the listed errors and warnings in the current file.",
    requires: ["filePath", "diagnostics"],
    build(context) {
      const file = requireFile(context);
      const diagnostics = context.diagnostics ?? [];
      if (diagnostics.length === 0)
        throw new LucyError("INVALID_ARGUMENT", "This prompt needs at least one diagnostic");
      const shown = diagnostics.slice(0, MAX_DIAGNOSTICS).map(formatDiagnostic);
      if (diagnostics.length > MAX_DIAGNOSTICS)
        shown.push(`- … and ${diagnostics.length - MAX_DIAGNOSTICS} more`);
      return `Fix these diagnostics in ${formatFileMention(file)}:\n${shown.join("\n")}\n\nKeep the changes minimal and explain each fix.`;
    },
  },
];

export function getPromptTemplate(id: PromptTemplateId): PromptTemplate {
  const template = PROMPT_TEMPLATES.find((candidate) => candidate.id === id);
  if (!template) throw new LucyError("NOT_FOUND", `Unknown prompt template "${id}"`);
  return template;
}

/** True when the context has everything the template requires (for enabling menu items). */
export function isPromptTemplateApplicable(id: PromptTemplateId, context: PromptContext): boolean {
  return getPromptTemplate(id).requires.every((requirement) => {
    if (requirement === "filePath") return Boolean(context.filePath?.trim());
    if (requirement === "selection") return validRange(context.selection);
    return (context.diagnostics?.length ?? 0) > 0;
  });
}

/** Builds the text to paste. Throws `LucyError("INVALID_ARGUMENT")` when context is missing. */
export function buildPrompt(id: PromptTemplateId, context: PromptContext): string {
  return getPromptTemplate(id).build(context).trimEnd();
}
