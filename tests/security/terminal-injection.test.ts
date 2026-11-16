/**
 * Item: terminal-escape injection through rendered content.
 *
 * A file can contain `ESC ] 0 ; title BEL` and friends. Lucy draws file content through OpenTUI,
 * which writes cells, not the text, to the terminal; this test pins down that ESC, BEL and C1
 * bytes inside content never reach the outer terminal as a sequence. It runs a real renderer
 * (`fixtures/inject-child.tsx`) inside a PTY and inspects the raw bytes, so an OpenTUI upgrade
 * that starts passing content bytes through fails here.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(30_000);

const REPO = join(import.meta.dir, "..", "..");
const CHILD = join(import.meta.dir, "fixtures", "inject-child.tsx");
const dataHome = realpathSync(mkdtempSync(join(tmpdir(), "lucy-inject-")));
afterAll(() => rmSync(dataHome, { recursive: true, force: true }));

async function renderInPty(): Promise<{ raw: string; exitCode: number | null }> {
  const chunks: Uint8Array[] = [];
  const child = Bun.spawn([process.execPath, "run", CHILD], {
    cwd: REPO,
    env: { ...process.env, XDG_DATA_HOME: dataHome, TERM: "xterm-256color", DEV: undefined },
    terminal: {
      cols: 220,
      rows: 40,
      data: (_terminal, bytes) => {
        chunks.push(new Uint8Array(bytes));
      },
    },
  });
  const killer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    await child.exited;
    // Let the last PTY reads arrive before closing the terminal.
    await Bun.sleep(100);
  } finally {
    clearTimeout(killer);
    child.terminal?.close();
  }
  // latin1 keeps one character per byte, so C1 bytes stay visible as \u0080-\u009f.
  return { raw: Buffer.concat(chunks).toString("latin1"), exitCode: child.exitCode };
}

describe("hostile content drawn by a real renderer", () => {
  test("no injected escape sequence reaches the terminal intact", async () => {
    const { raw, exitCode } = await renderInPty();
    expect(exitCode).toBe(0);

    // Positive control: the content was really drawn (each element, and the hostile text's
    // printable parts), so the absence of sequences below is meaningful. `<text>`, `<code>` and
    // `<markdown>` drop the control bytes; `<input>` shows them in caret notation (`^[`, `^G`,
    // `<9b>`) and scrolls to the end of its value, so its own label is not visible.
    for (const label of ["text:", "child:", "code:", "md:", "para ", "PWNED-TITLE", "RED", "CLEAR", "CLIP"]) {
      expect(raw).toContain(label);
    }
    expect(raw).toContain("^[]0;PWNED-TITLE^G");

    // Any OSC 0/1/2 (window title) whose text comes from the content.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point.
    const titleFromContent = /\u001b\][0-9]*;[^\u0007\u001b]*PWNED/;
    expect(titleFromContent.test(raw)).toBe(false);
    const forbidden: Array<[string, string]> = [
      ["OSC title", "\u001b]0;PWNED-TITLE"],
      ["CSI color from content", "\u001b[31mRED"],
      ["CSI clear screen", "\u001b[2JCLEAR"],
      ["OSC 52 clipboard write", "\u001b]52;"],
      ["OSC 8 hyperlink to the injected URL", "\u001b]8;;https://example.invalid"],
      ["DCS request", "\u001bP+q544e"],
      ["RIS full reset", "\u001bcRESET"],
      ["raw C1 CSI", "\u009b31mC1CSI"],
      ["UTF-8 encoded C1 CSI (latin1 view)", "\u00c2\u009b31mC1CSI"],
      ["raw C1 OSC", "\u009d0;C1OSC"],
      ["UTF-8 encoded C1 OSC (latin1 view)", "\u00c2\u009d0;C1OSC"],
      ["BEL from content", "\u0007BEL"],
    ];
    const found = forbidden.filter(([, sequence]) => raw.includes(sequence)).map(([name]) => name);
    expect(found).toEqual([]);
  });
});
