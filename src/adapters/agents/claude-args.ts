/**
 * Inspection of user-configured Claude Code arguments.
 *
 * Lucy passes the user's own extra arguments through unchanged (they are the user's decision),
 * but it must never let a permission bypass or an auto-submitted prompt slip in unnoticed. This
 * module classifies arguments using the option table of `claude --help` (Claude Code 2.1.325),
 * so that option values are not mistaken for prompts. Unknown options are assumed to take no
 * value, which errs on the side of warning.
 */
import type { AgentLaunchWarning } from "./agent-provider";

/** Options that take exactly one value (`--model opus` or `--model=opus`). */
const VALUE_OPTIONS = new Set([
  "--agent",
  "--agents",
  "--append-system-prompt",
  "--autocompact",
  "--debug-file",
  "--effort",
  "--environment",
  "--fallback-model",
  "--input-format",
  "--json-schema",
  "--max-budget-usd",
  "--model",
  "-n",
  "--name",
  "--output-format",
  "--permission-mode",
  "--permission-prompts",
  "--plugin-dir",
  "--plugin-url",
  "--remote-control-session-name-prefix",
  "--session-id",
  "--setting-sources",
  "--settings",
  "--system-prompt",
  "--system-prompt-snapshot",
]);

/** Options with an optional value: the next token is consumed unless it starts with "-". */
const OPTIONAL_VALUE_OPTIONS = new Set([
  "-r",
  "--resume",
  "-d",
  "--debug",
  "--cloud",
  "--from-pr",
  "--prompt-suggestions",
  "--remote-control",
  "--teleport",
  "-w",
  "--worktree",
]);

/** Variadic options: every following token up to the next option is a value. */
const VARIADIC_OPTIONS = new Set([
  "--add-dir",
  "--allowedTools",
  "--allowed-tools",
  "--betas",
  "--disallowedTools",
  "--disallowed-tools",
  "--file",
  "--mcp-config",
  "--tools",
]);

const BYPASS_FLAGS = new Set(["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"]);
const MODE_FLAGS = new Set([
  "-c",
  "--continue",
  "-r",
  "--resume",
  "--session-id",
  "--fork-session",
  "--from-pr",
]);
const PRINT_FLAGS = new Set(["-p", "--print"]);

function splitOption(token: string): { name: string; inlineValue: string | null } {
  const eq = token.indexOf("=");
  return token.startsWith("--") && eq > 2
    ? { name: token.slice(0, eq), inlineValue: token.slice(eq + 1) }
    : { name: token, inlineValue: null };
}

function settingsBypass(value: string): boolean {
  // Only inline JSON can be checked; a settings file path is opaque here.
  return value.trimStart().startsWith("{") && /bypassPermissions/.test(value);
}

function permissionWarning(arg: string, detail: string): AgentLaunchWarning {
  return {
    code: "PERMISSION_BYPASS",
    arg,
    message: `Your extra argument "${arg}" ${detail}. Lucy passes it through because you configured it.`,
  };
}

/**
 * Returns warnings for user-supplied Claude Code arguments. Never modifies or drops arguments.
 */
export function inspectClaudeArgs(args: readonly string[]): AgentLaunchWarning[] {
  const warnings: AgentLaunchWarning[] = [];
  let index = 0;
  let positionalOnly = false;
  const positional = (arg: string) =>
    warnings.push({
      code: "PROMPT_ARGUMENT",
      arg,
      message: `Your extra argument "${arg}" is not an option: Claude Code would run it as a prompt or subcommand as soon as it starts.`,
    });

  while (index < args.length) {
    const token = args[index] as string;
    index++;
    if (positionalOnly || !token.startsWith("-") || token === "-") {
      positional(token);
      continue;
    }
    if (token === "--") {
      positionalOnly = true;
      continue;
    }
    const { name, inlineValue } = splitOption(token);
    let value = inlineValue;

    if (VALUE_OPTIONS.has(name)) {
      if (value === null && index < args.length) value = args[index++] as string;
    } else if (OPTIONAL_VALUE_OPTIONS.has(name)) {
      const next = args[index];
      if (value === null && next !== undefined && !next.startsWith("-")) {
        value = next;
        index++;
      }
    } else if (VARIADIC_OPTIONS.has(name)) {
      while (index < args.length && !(args[index] as string).startsWith("-")) index++;
    }

    if (BYPASS_FLAGS.has(name)) {
      warnings.push(
        permissionWarning(
          token,
          name === "--dangerously-skip-permissions"
            ? "turns off all of Claude Code's permission prompts"
            : "lets the session switch to a mode without permission prompts",
        ),
      );
    } else if (name === "--permission-mode" && value === "bypassPermissions") {
      warnings.push(
        permissionWarning(`${name} ${value}`, "turns off all of Claude Code's permission prompts"),
      );
    } else if (name === "--settings" && value !== null && settingsBypass(value)) {
      warnings.push(permissionWarning(name, "contains settings that turn off permission prompts"));
    }
    if (PRINT_FLAGS.has(name)) {
      warnings.push({
        code: "NON_INTERACTIVE",
        arg: token,
        message: `Your extra argument "${token}" runs Claude Code non-interactively: it skips the workspace trust dialog and exits after one answer.`,
      });
    }
    if (MODE_FLAGS.has(name)) {
      warnings.push({
        code: "MODE_OVERRIDE",
        arg: token,
        message: `Your extra argument "${token}" changes which conversation Claude Code opens, overriding Lucy's launch mode.`,
      });
    }
  }
  return warnings;
}
