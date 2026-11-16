import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildOpenCommand,
  detectEditors,
  openInExternalEditor,
  type ResolvedEditor,
  resolveEditor,
  splitCommandLine,
  type TerminalController,
} from "@/adapters/editor";
import { isLucyError } from "@/core/errors";
import { createTempDirs } from "./helpers";

const tempDir = createTempDirs("ext");

/**
 * A fake terminal editor: records its arguments (one per line) to $FAKE_EDITOR_LOG, appends a
 * line to the file it was given (the last argument that is not a "+..." cursor argument), and
 * exits with $FAKE_EDITOR_EXIT. $FAKE_EDITOR_NOEDIT=1 leaves the file alone.
 */
const FAKE_EDITOR = `#!/bin/sh
: > "$FAKE_EDITOR_LOG"
for arg in "$@"; do printf '%s\\n' "$arg" >> "$FAKE_EDITOR_LOG"; done
target=""
for arg in "$@"; do case "$arg" in +*) ;; *) target="$arg" ;; esac; done
if [ "$FAKE_EDITOR_NOEDIT" != "1" ]; then printf 'edited by fake editor\\n' >> "$target"; fi
exit "\${FAKE_EDITOR_EXIT:-0}"
`;

function installFake(binDir: string, name: string): string {
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, name);
  writeFileSync(path, FAKE_EDITOR);
  chmodSync(path, 0o755);
  return path;
}

interface Fixture {
  root: string;
  bin: string;
  log: string;
  env: Record<string, string>;
}

function fixture(): Fixture {
  const root = tempDir();
  const bin = join(tempDir(), "bin");
  mkdirSync(bin);
  const log = join(tempDir(), "args.log");
  return { root, bin, log, env: { PATH: bin, HOME: "/home/test", FAKE_EDITOR_LOG: log } };
}

function recordedArgs(log: string): string[] {
  return readFileSync(log, "utf8").split("\n").slice(0, -1);
}

class FakeTerminal implements TerminalController {
  readonly events: string[] = [];
  constructor(
    private readonly hooks: { onSuspend?: () => void; failSuspend?: boolean; failResume?: boolean } = {},
  ) {}
  async suspend(): Promise<void> {
    this.events.push("suspend");
    this.hooks.onSuspend?.();
    if (this.hooks.failSuspend) throw new Error("suspend failed");
  }
  async resume(): Promise<void> {
    this.events.push("resume");
    if (this.hooks.failResume) throw new Error("resume failed");
  }
}

function editor(
  id: ResolvedEditor["id"],
  program = `/usr/local/bin/${id ?? "ed"}`,
  args: string[] = [],
): ResolvedEditor {
  return { id, displayName: String(id), program, args, template: null, source: "setting" };
}

describe("splitCommandLine", () => {
  test("words, quotes and escapes", () => {
    expect(splitCommandLine("code --wait")).toEqual({ ok: true, argv: ["code", "--wait"] });
    expect(splitCommandLine("  nvim\t-u  NONE ")).toEqual({ ok: true, argv: ["nvim", "-u", "NONE"] });
    expect(splitCommandLine(`"/Applications/My Editor/bin/ed" -w`)).toEqual({
      ok: true,
      argv: ["/Applications/My Editor/bin/ed", "-w"],
    });
    expect(splitCommandLine(`vim -c 'set nu' a\\ b ""`)).toEqual({
      ok: true,
      argv: ["vim", "-c", "set nu", "a b", ""],
    });
    expect(splitCommandLine(`ed "say \\"hi\\" \\\\ \\n"`)).toEqual({
      ok: true,
      argv: ["ed", 'say "hi" \\ \\n'],
    });
    expect(splitCommandLine("ed 'it''s'")).toEqual({ ok: true, argv: ["ed", "its"] });
  });

  test("a leading ~ in the program becomes $HOME", () => {
    expect(splitCommandLine("~/bin/micro -x", "/home/me")).toEqual({
      ok: true,
      argv: ["/home/me/bin/micro", "-x"],
    });
    expect(splitCommandLine("micro ~/notes", "/home/me")).toEqual({ ok: true, argv: ["micro", "~/notes"] });
  });

  test("anything that needs a shell is refused", () => {
    for (const value of [
      "vim; rm -rf x",
      "ed $HOME/x",
      "ed `x`",
      "a | b",
      "a && b",
      "ed > out",
      'ed "$X"',
      "f(x)",
    ]) {
      const result = splitCommandLine(value);
      expect(result.ok).toBe(false);
    }
    expect(splitCommandLine("ed 'open")).toEqual({
      ok: false,
      message: "The command has an unterminated single quote",
    });
    expect(splitCommandLine('ed "open')).toEqual({
      ok: false,
      message: "The command has an unterminated double quote",
    });
    expect(splitCommandLine("   ")).toEqual({ ok: false, message: "The command is empty" });
    expect(splitCommandLine("ed\\")).toEqual({
      ok: false,
      message: "The command ends with a lone backslash",
    });
    expect(splitCommandLine("ed '$HOME' \\$x")).toEqual({ ok: true, argv: ["ed", "$HOME", "$x"] });
  });
});

describe("detectEditors", () => {
  test("finds known editors on PATH in preference order, and reads $VISUAL / $EDITOR", () => {
    const { bin, env } = fixture();
    installFake(bin, "vim");
    installFake(bin, "micro");
    installFake(bin, "pico");
    const detection = detectEditors({ ...env, VISUAL: "code --wait", EDITOR: "vim -u NONE" });
    expect(detection.installed.map((e) => [e.id, e.program])).toEqual([
      ["micro", join(bin, "micro")],
      ["vim", join(bin, "vim")],
      ["nano", join(bin, "pico")],
    ]);
    expect(detection.visual).toEqual({
      variable: "VISUAL",
      value: "code --wait",
      argv: ["code", "--wait"],
      problem: '"code" was not found on PATH',
      program: null,
      id: null,
    });
    expect(detection.editor).toMatchObject({
      argv: ["vim", "-u", "NONE"],
      program: join(bin, "vim"),
      id: "vim",
      problem: null,
    });
  });

  test("unset or blank variables are null; unsplittable values explain why", () => {
    const { env } = fixture();
    expect(detectEditors({ ...env, VISUAL: "  " })).toMatchObject({
      installed: [],
      visual: null,
      editor: null,
    });
    expect(detectEditors({ ...env, EDITOR: "vim; ls" }).editor).toMatchObject({
      argv: null,
      problem: 'The command uses ";", which needs a shell',
    });
  });
});

describe("resolveEditor", () => {
  test("auto prefers $VISUAL, then $EDITOR, then detected editors", () => {
    const { bin, env } = fixture();
    installFake(bin, "hx");
    installFake(bin, "nvim");
    installFake(bin, "code");

    const visual = resolveEditor("auto", { ...env, VISUAL: "code --wait", EDITOR: "nvim" });
    expect(visual).toMatchObject({
      ok: true,
      editor: {
        id: null,
        displayName: "code",
        program: join(bin, "code"),
        args: ["--wait"],
        source: "visual",
      },
    });

    const fromEditor = resolveEditor("auto", { ...env, EDITOR: "nvim --clean" });
    expect(fromEditor).toMatchObject({
      ok: true,
      editor: { id: "nvim", displayName: "Neovim", args: ["--clean"], source: "editor" },
    });

    const detected = resolveEditor("auto", env);
    expect(detected).toMatchObject({
      ok: true,
      editor: { id: "hx", displayName: "Helix", source: "detected" },
    });
  });

  test("auto skips unusable variables with a note", () => {
    const { bin, env } = fixture();
    installFake(bin, "micro");
    const result = resolveEditor("auto", { ...env, VISUAL: "subl -w", EDITOR: "vim | tee" });
    expect(result).toMatchObject({ ok: true, editor: { id: "micro", source: "detected" } });
    expect(result.notes).toEqual([
      '$VISUAL ("subl -w") is not usable: "subl" was not found on PATH.',
      '$EDITOR ("vim | tee") is not usable: The command uses "|", which needs a shell.',
    ]);
  });

  test("auto with nothing available", () => {
    const { env } = fixture();
    expect(resolveEditor("auto", env)).toMatchObject({ ok: false, reason: "none-available" });
  });

  test("a known name must be installed (missing editor)", () => {
    const { bin, env } = fixture();
    expect(resolveEditor("hx", env)).toMatchObject({
      ok: false,
      reason: "not-found",
      message: "Helix (hx) is not installed or not on PATH.",
    });
    installFake(bin, "helix");
    expect(resolveEditor("hx", env)).toMatchObject({
      ok: true,
      editor: { id: "hx", program: join(bin, "helix") },
    });
  });

  test("custom argv: placeholders make a template; known programs keep their cursor syntax", () => {
    const { bin, env } = fixture();
    installFake(bin, "code");
    installFake(bin, "nvim");
    expect(resolveEditor(["code", "--wait", "--goto", "{file}:{line}:{column}"], env)).toMatchObject({
      ok: true,
      editor: {
        id: null,
        program: join(bin, "code"),
        args: [],
        template: ["--wait", "--goto", "{file}:{line}:{column}"],
      },
    });
    expect(resolveEditor(["nvim", "--clean"], env)).toMatchObject({
      ok: true,
      editor: { id: "nvim", args: ["--clean"], template: null },
    });
    expect(resolveEditor(["missing-editor"], env)).toMatchObject({ ok: false, reason: "not-found" });
    expect(resolveEditor([], env)).toMatchObject({ ok: false, reason: "invalid" });
    expect(resolveEditor([join(bin, "code")], env)).toMatchObject({
      ok: true,
      editor: { program: join(bin, "code") },
    });
    expect(resolveEditor(["relative/code"], env)).toMatchObject({ ok: false, reason: "not-found" });
  });
});

describe("buildOpenCommand", () => {
  const file = "/w/src/app.ts";

  test("cursor syntax per editor", () => {
    expect(buildOpenCommand(editor("micro"), { file, line: 42, column: 7 })).toEqual([
      "/usr/local/bin/micro",
      file,
      "+42:7",
    ]);
    expect(buildOpenCommand(editor("micro"), { file, line: 42 })).toEqual([
      "/usr/local/bin/micro",
      file,
      "+42",
    ]);
    expect(buildOpenCommand(editor("hx"), { file, line: 42, column: 7 })).toEqual([
      "/usr/local/bin/hx",
      `${file}:42:7`,
    ]);
    expect(buildOpenCommand(editor("hx"), { file, line: 42 })).toEqual(["/usr/local/bin/hx", `${file}:42:1`]);
    expect(buildOpenCommand(editor("nvim"), { file, line: 42, column: 7 })).toEqual([
      "/usr/local/bin/nvim",
      "+42",
      "+normal! 06l",
      file,
    ]);
    expect(buildOpenCommand(editor("vim"), { file, line: 42, column: 1 })).toEqual([
      "/usr/local/bin/vim",
      "+42",
      file,
    ]);
    expect(buildOpenCommand(editor("vi"), { file, line: 42, column: 7 })).toEqual([
      "/usr/local/bin/vi",
      "+42",
      file,
    ]);
    expect(buildOpenCommand(editor("nano"), { file, line: 42, column: 7 })).toEqual([
      "/usr/local/bin/nano",
      "+42,7",
      file,
    ]);
    expect(buildOpenCommand(editor(null, "/usr/bin/ed", ["--wait"]), { file, line: 42 })).toEqual([
      "/usr/bin/ed",
      "--wait",
      file,
    ]);
  });

  test("without a line, or with an invalid one, only the file is passed", () => {
    expect(buildOpenCommand(editor("vim"), { file })).toEqual(["/usr/local/bin/vim", file]);
    expect(buildOpenCommand(editor("micro"), { file, line: 0, column: 3 })).toEqual([
      "/usr/local/bin/micro",
      file,
    ]);
    expect(buildOpenCommand(editor("micro"), { file, line: 2.5 })).toEqual(["/usr/local/bin/micro", file]);
  });

  test("$EDITOR arguments come before the file and cursor arguments", () => {
    expect(buildOpenCommand(editor("nvim", "/bin/nvim", ["--clean"]), { file, line: 3 })).toEqual([
      "/bin/nvim",
      "--clean",
      "+3",
      file,
    ]);
  });

  test("templates substitute in one pass and append the file when {file} is absent", () => {
    const template: ResolvedEditor = {
      ...editor(null, "/bin/code"),
      template: ["--wait", "--goto", "{file}:{line}:{column}"],
    };
    expect(buildOpenCommand(template, { file: "/w/{line}.ts", line: 5, column: 2 })).toEqual([
      "/bin/code",
      "--wait",
      "--goto",
      "/w/{line}.ts:5:2",
    ]);
    const noFile: ResolvedEditor = { ...editor(null, "/bin/ed"), template: ["+{line}"] };
    expect(buildOpenCommand(noFile, { file })).toEqual(["/bin/ed", "+1", file]);
  });

  test("relative names that look like options or Vim commands are made explicit", () => {
    expect(buildOpenCommand(editor("vim"), { file: "+!rm -rf x" })).toEqual([
      "/usr/local/bin/vim",
      "./+!rm -rf x",
    ]);
    expect(buildOpenCommand(editor("micro"), { file: "-config-dir" })).toEqual([
      "/usr/local/bin/micro",
      "./-config-dir",
    ]);
    expect(() => buildOpenCommand(editor("vim"), { file: "" })).toThrow();
  });
});

describe("openInExternalEditor", () => {
  test("suspends, runs the editor at the line with inherited stdio, resumes, reports the change", async () => {
    const { root, bin, log, env } = fixture();
    const program = installFake(bin, "micro");
    // A name a shell would expand: proves no shell is involved.
    const name = "weird $(touch pwned) ;name.txt";
    writeFileSync(join(root, name), "original\n");
    const terminal = new FakeTerminal();
    const sigintListeners = process.listenerCount("SIGINT");

    const result = await openInExternalEditor({
      editor: editor("micro", program),
      file: name,
      line: 12,
      column: 3,
      cwd: root,
      terminal,
      env,
    });

    expect(terminal.events).toEqual(["suspend", "resume"]);
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.changed).toBe(true);
    expect(result.deleted).toBe(false);
    expect(result.file).toBe(join(root, name));
    expect(recordedArgs(log)).toEqual([join(root, name), "+12:3"]);
    expect(result.argv).toEqual([program, join(root, name), "+12:3"]);
    expect(readFileSync(join(root, name), "utf8")).toBe("original\nedited by fake editor\n");
    expect(existsSync(join(root, "pwned"))).toBe(false);
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
  });

  test("non-zero exit is a result, not an exception; unchanged file is reported", async () => {
    const { root, bin, log, env } = fixture();
    const program = installFake(bin, "vim");
    writeFileSync(join(root, "a.txt"), "x\n");
    const terminal = new FakeTerminal();
    const result = await openInExternalEditor({
      editor: editor("vim", program),
      file: "a.txt",
      line: 4,
      column: 2,
      cwd: root,
      terminal,
      env: { ...env, FAKE_EDITOR_EXIT: "3", FAKE_EDITOR_NOEDIT: "1" },
    });
    expect(result).toMatchObject({ exitCode: 3, changed: false, deleted: false });
    expect(recordedArgs(log)).toEqual(["+4", "+normal! 01l", join(root, "a.txt")]);
    expect(terminal.events).toEqual(["suspend", "resume"]);
  });

  test("editor missing: fails before suspending the screen", async () => {
    const { root } = fixture();
    writeFileSync(join(root, "a.txt"), "x\n");
    const terminal = new FakeTerminal();
    const error = await openInExternalEditor({
      editor: editor("micro", join(root, "no-such-editor")),
      file: "a.txt",
      cwd: root,
      terminal,
    }).catch((e: unknown) => e);
    expect(isLucyError(error, "SPAWN_FAILED")).toBe(true);
    expect(terminal.events).toEqual([]);
  });

  test("exception while running (editor vanishes after suspend): resume still happens", async () => {
    const { root, bin, env } = fixture();
    const program = installFake(bin, "micro");
    writeFileSync(join(root, "a.txt"), "x\n");
    const terminal = new FakeTerminal({ onSuspend: () => rmSync(program) });
    const error = await openInExternalEditor({
      editor: editor("micro", program),
      file: "a.txt",
      cwd: root,
      terminal,
      env,
    }).catch((e: unknown) => e);
    expect(isLucyError(error, "SPAWN_FAILED")).toBe(true);
    expect(terminal.events).toEqual(["suspend", "resume"]);
  });

  test("suspend failure: the editor does not run and resume is still called", async () => {
    const { root, bin, log, env } = fixture();
    const program = installFake(bin, "micro");
    writeFileSync(join(root, "a.txt"), "x\n");
    const terminal = new FakeTerminal({ failSuspend: true });
    const error = await openInExternalEditor({
      editor: editor("micro", program),
      file: "a.txt",
      cwd: root,
      terminal,
      env,
    }).catch((e: unknown) => e);
    expect((error as Error).message).toBe("suspend failed");
    expect(terminal.events).toEqual(["suspend", "resume"]);
    expect(existsSync(log)).toBe(false);
  });

  test("resume failure after a successful edit is reported", async () => {
    const { root, bin, env } = fixture();
    const program = installFake(bin, "micro");
    writeFileSync(join(root, "a.txt"), "x\n");
    const terminal = new FakeTerminal({ failResume: true });
    const error = await openInExternalEditor({
      editor: editor("micro", program),
      file: "a.txt",
      cwd: root,
      terminal,
      env,
    }).catch((e: unknown) => e);
    expect((error as Error).message).toBe("resume failed");
    expect(terminal.events).toEqual(["suspend", "resume"]);
  });

  test("files outside the workspace are refused unless explicitly allowed", async () => {
    const { root, bin, log, env } = fixture();
    const program = installFake(bin, "micro");
    const outside = join(tempDir(), "outside.txt");
    writeFileSync(outside, "x\n");
    const terminal = new FakeTerminal();
    for (const file of [outside, "../outside.txt"]) {
      const error = await openInExternalEditor({
        editor: editor("micro", program),
        file,
        cwd: root,
        terminal,
        env,
      }).catch((e: unknown) => e);
      expect(isLucyError(error, "OUTSIDE_WORKSPACE")).toBe(true);
    }
    expect(terminal.events).toEqual([]);

    const allowed = await openInExternalEditor({
      editor: editor("micro", program),
      file: outside,
      cwd: root,
      terminal,
      env,
      allowOutsideWorkspace: true,
    });
    expect(allowed.changed).toBe(true);
    expect(recordedArgs(log)).toEqual([outside]);
  });

  test("a new file created by the editor counts as changed; a deleted one as deleted", async () => {
    const { root, bin, env } = fixture();
    const program = installFake(bin, "micro");
    const created = await openInExternalEditor({
      editor: editor("micro", program),
      file: "new.txt",
      cwd: root,
      terminal: new FakeTerminal(),
      env,
    });
    expect(created).toMatchObject({ changed: true, deleted: false });

    const deleter = join(bin, "deleter");
    writeFileSync(deleter, '#!/bin/sh\n/bin/rm -f "$1"\n');
    chmodSync(deleter, 0o755);
    const deleted = await openInExternalEditor({
      editor: editor(null, deleter),
      file: "new.txt",
      cwd: root,
      terminal: new FakeTerminal(),
      env,
    });
    expect(deleted).toMatchObject({ changed: true, deleted: true, exitCode: 0 });
  });

  test("end to end: resolve from $EDITOR with arguments, then open", async () => {
    const { root, bin, log, env } = fixture();
    installFake(bin, "nvim");
    writeFileSync(join(root, "a.txt"), "x\n");
    const resolved = resolveEditor("auto", { ...env, EDITOR: "nvim --clean" });
    if (!resolved.ok) throw new Error(resolved.message);
    const result = await openInExternalEditor({
      editor: resolved.editor,
      file: "a.txt",
      line: 2,
      cwd: root,
      terminal: new FakeTerminal(),
      env,
    });
    expect(result.changed).toBe(true);
    expect(recordedArgs(log)).toEqual(["--clean", "+2", join(root, "a.txt")]);
  });
});
