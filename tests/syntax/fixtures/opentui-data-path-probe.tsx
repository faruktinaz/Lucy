/**
 * Child process for `data-path-confinement.test.ts`. The parent starts it with HOME and
 * XDG_DATA_HOME pointing at temp dirs, so even a failure here can never touch the real home.
 *
 * Usage: bun opentui-data-path-probe.tsx <configure|default> <absolute injected dir>
 * Renders `<code>` and `<markdown>` WITHOUT a `treeSitterClient`, i.e. through OpenTUI's global
 * client, waits until both are highlighted, and prints a JSON summary on stdout.
 */
import { type CodeRenderable, getDataPaths, SyntaxStyle } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { configureOpenTuiDataPath } from "../../../src/adapters/syntax";

const [mode, injected] = process.argv.slice(2);
if (mode === "configure") {
  if (!injected) throw new Error("missing injected dir");
  configureOpenTuiDataPath(injected);
}

const setup = await testRender(<box />, { width: 60, height: 12 });
const style = SyntaxStyle.fromStyles(
  { default: { fg: "#c0c0c0" }, keyword: { fg: "#ff0000" } },
  setup.renderer.nativeScene,
);
const root = createRoot(setup.renderer);
let code: CodeRenderable | null = null;
await act(async () => {
  root.render(
    <box flexDirection="column">
      <code
        ref={(r: CodeRenderable | null) => {
          code = r;
        }}
        content="const a = 1"
        filetype="typescript"
        syntaxStyle={style}
        width={60}
        height={1}
      />
      <markdown content={"# Title\n\n```ts\nlet b = 2\n```\n"} syntaxStyle={style} width={60} />
    </box>,
  );
});
await setup.renderOnce();
const view = code as CodeRenderable | null;
await view?.highlightingDone;

const isRed = (text: string): boolean =>
  setup.captureSpans().lines.some((line) =>
    line.spans.some((span) => {
      const [r, g] = span.fg.toInts();
      return span.text.includes(text) && r === 255 && g === 0;
    }),
  );

// The fenced block highlights asynchronously through a child CodeRenderable.
let codeColored = false;
let fenceColored = false;
const deadline = Date.now() + 5000;
while (Date.now() < deadline && !(codeColored && fenceColored)) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  await setup.renderOnce();
  codeColored = isRed("const");
  fenceColored = isRed("let");
}

const globalDataPath = getDataPaths().globalDataPath;
await act(async () => root.unmount());
await act(async () => setup.renderer.destroy());
style.destroy();
await Bun.write(Bun.stdout, `${JSON.stringify({ codeColored, fenceColored, globalDataPath })}\n`);
process.exit(0);
