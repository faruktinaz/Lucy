/**
 * How each setting is presented and edited, derived from its schema descriptor so the
 * Settings UI can never drift from validation.
 */
import type { z } from "zod";
import type { SettingDescriptor, SettingOption } from "@/core/config/schema";
import { formatCommandLine, parseCommandLine } from "./command-line";

export type SettingControl =
  | { readonly kind: "toggle" }
  | { readonly kind: "select"; readonly options: readonly SettingOption[] }
  /** A select plus a custom `#rrggbb` value (accent). */
  | { readonly kind: "select-or-color"; readonly options: readonly SettingOption[] }
  /** A select plus a custom command as an argv list (external editor). */
  | { readonly kind: "select-or-command"; readonly options: readonly SettingOption[] }
  | { readonly kind: "number"; readonly min: number; readonly max: number; readonly unit?: string }
  | { readonly kind: "text" }
  | { readonly kind: "list" }
  /** Edited in the Keyboard Shortcuts screen; the settings row links there. */
  | { readonly kind: "keybindings" };

export type ControlKind = SettingControl["kind"];

/** Which text editor a draft belongs to. */
export type DraftKind = "number" | "text" | "color" | "command" | "list-entry";

type AnyDescriptor = SettingDescriptor<string, unknown>;

export function controlFor(descriptor: AnyDescriptor): SettingControl {
  const options = descriptor.options ?? [];
  switch (descriptor.type) {
    case "boolean":
      return { kind: "toggle" };
    case "enum":
      return { kind: "select", options };
    case "enum-or-color":
      return { kind: "select-or-color", options };
    case "enum-or-command":
      return { kind: "select-or-command", options };
    case "integer":
      return {
        kind: "number",
        min: descriptor.min ?? 0,
        max: descriptor.max ?? Number.MAX_SAFE_INTEGER,
        unit: descriptor.unit,
      };
    case "string":
      return { kind: "text" };
    case "string-list":
      return { kind: "list" };
    case "keybinding-map":
      return { kind: "keybindings" };
  }
}

const EMPTY_TEXT_LABELS: Readonly<Record<string, string>> = {
  "ai.executable": "Found on PATH",
  "terminal.shell": "$SHELL",
};

/** Short display form of a value for the list row ("On", "Tokyo Night", "30 columns"). */
export function formatSettingValue(descriptor: AnyDescriptor, value: unknown): string {
  const option = typeof value === "string" ? descriptor.options?.find((o) => o.value === value) : undefined;
  if (option) return option.label;
  switch (descriptor.type) {
    case "boolean":
      return value === true ? "On" : "Off";
    case "integer":
      return descriptor.unit ? `${String(value)} ${descriptor.unit}` : String(value);
    case "string":
      return typeof value === "string" && value !== ""
        ? value
        : (EMPTY_TEXT_LABELS[descriptor.path] ?? "Not set");
    case "string-list":
      return Array.isArray(value) && value.length > 0 ? value.join(", ") : "None";
    case "enum-or-command":
      return Array.isArray(value) ? formatCommandLine(value as string[]) : String(value);
    case "keybinding-map": {
      const count = value && typeof value === "object" ? Object.keys(value).length : 0;
      return count === 0
        ? "No custom shortcuts"
        : `${count} custom ${count === 1 ? "shortcut" : "shortcuts"}`;
    }
    default:
      return String(value);
  }
}

/** The text an edit starts from. */
export function initialDraft(kind: DraftKind, value: unknown): string {
  switch (kind) {
    case "number":
      return String(value);
    case "text":
      return typeof value === "string" ? value : "";
    case "color":
      return typeof value === "string" && value.startsWith("#") ? value : "#";
    case "command":
      return Array.isArray(value) ? formatCommandLine(value as string[]) : "";
    case "list-entry":
      return typeof value === "string" ? value : "";
  }
}

/** A readable message for the first schema issue, in the vocabulary of the settings screen. */
export function issueMessage(descriptor: AnyDescriptor, error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue?.code === "custom" && issue.message) return capitalize(issue.message);
  if (descriptor.type === "string-list" && issue) {
    if (issue.code === "too_small" && issue.path.length > 0) return "An entry cannot be empty";
    if (issue.code === "too_big" && issue.path.length === 0)
      return `At most ${String(issue.maximum)} entries`;
    if (issue.code === "too_big") return "This entry is too long";
  }
  if (descriptor.type === "string" && issue?.code === "too_big") return "This value is too long";
  return `Expected ${descriptor.expected}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export type DraftResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Converts a draft into the setting's value and validates it with the setting's own schema.
 * For list entries, `list` and `index` give the list being edited (index null adds).
 */
export function parseDraft(
  descriptor: AnyDescriptor,
  kind: DraftKind,
  draft: string,
  list?: { items: readonly string[]; index: number | null },
): DraftResult {
  let candidate: unknown;
  switch (kind) {
    case "number": {
      const trimmed = draft.trim();
      if (!/^-?\d+$/.test(trimmed)) return { ok: false, error: "Enter a whole number" };
      candidate = Number(trimmed);
      break;
    }
    case "text":
      candidate = draft;
      break;
    case "color":
      candidate = draft.trim().toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(candidate as string))
        return { ok: false, error: "Enter a color as #rrggbb" };
      break;
    case "command": {
      const parsed = parseCommandLine(draft);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      candidate = parsed.argv;
      break;
    }
    case "list-entry": {
      const items = [...(list?.items ?? [])];
      if (list?.index === null || list?.index === undefined) items.push(draft);
      else items[list.index] = draft;
      candidate = items;
      break;
    }
  }
  const result = descriptor.schema.safeParse(candidate);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: issueMessage(descriptor, result.error) };
}
