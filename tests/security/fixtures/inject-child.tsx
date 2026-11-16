/**
 * Child process for `terminal-injection.test.ts`: a real OpenTUI renderer (not the test
 * renderer) that draws hostile strings through `<text>`, `<code>`, `<input>` and `<markdown>`,
 * then exits. The parent runs it inside a PTY and inspects every byte it wrote.
 * The parent points XDG_DATA_HOME at a temp dir, so OpenTUI's tree-sitter folders land there.
 */
import { createCliRenderer, SyntaxStyle } from "@opentui/core";
import { createRoot } from "@opentui/react";

/** Kept in sync with HOSTILE in terminal-injection.test.ts (the parent checks for its pieces). */
const HOSTILE = [
  "A\u001b]0;PWNED-TITLE\u0007",
  "B\u001b[31mRED\u001b[2JCLEAR",
  "\u009b31mC1CSI\u009d0;C1OSC\u0007",
  "\u001b]52;c;cHduZWQ=\u0007CLIP",
  "\u001b]8;;https://example.invalid\u0007LINK\u001b]8;;\u0007",
  "\u001bP+q544e\u001b\\DCS",
  "\u0007BEL\u001bcRESET",
].join("");

const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: false, targetFps: 30 });
const style = SyntaxStyle.fromStyles({ default: { fg: "#c0c0c0" } }, renderer.nativeScene);
createRoot(renderer).render(
  <box flexDirection="column" width={200}>
    <text content={`text:${HOSTILE}`} />
    <text>{`child:${HOSTILE}`}</text>
    <code content={`code:${HOSTILE}`} filetype="plaintext" syntaxStyle={style} width={200} height={1} />
    <input value={`input:${HOSTILE}`} width={200} />
    <markdown
      content={`# md:${HOSTILE}\n\npara ${HOSTILE}\n\n\`\`\`\n${HOSTILE}\n\`\`\`\n`}
      syntaxStyle={style}
      width={200}
    />
  </box>,
);
setTimeout(async () => {
  renderer.destroy();
  await renderer.closed;
  process.exit(0);
}, 900);
