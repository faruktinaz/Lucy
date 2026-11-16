/**
 * A synthetic 120x35 scene that exercises everything the screenshot renderer must get right:
 * panels and borders in every style, text attributes, wide CJK and emoji, Nerd Font and
 * powerline glyphs, Turkish letters, indexed and default colors, block elements and a
 * semi-transparent overlay with a dialog on top.
 */
import { RGBA, TextAttributes } from "@opentui/core";

const C = {
  base: "#1a1b26",
  mantle: "#16161e",
  surface: "#24283b",
  overlay: "#414868",
  text: "#c0caf5",
  subtext: "#9aa5ce",
  muted: "#565f89",
  blue: "#7aa2f7",
  cyan: "#7dcfff",
  green: "#9ece6a",
  yellow: "#e0af68",
  red: "#f7768e",
  magenta: "#bb9af7",
};

// Nerd Font and powerline glyphs live in the Private Use Area. They are built from code points
// because formatters rewrite "\uF115" escapes into invisible literal characters.
const glyph = (code: number) => String.fromCodePoint(code);
const NF = {
  folder: glyph(0xf115),
  typescript: glyph(0xe628),
  react: glyph(0xe7ba),
  markdown: glyph(0xe73e),
  config: glyph(0xe615),
  lock: glyph(0xf023),
  branch: glyph(0xe0a0),
  github: glyph(0xf09b),
  rust: glyph(0xe7a8),
  arrowRight: glyph(0xe0b0),
  arrowLeft: glyph(0xe0b2),
};

const tree: [indent: number, icon: string, name: string, color: string][] = [
  [0, NF.folder, "lucy-workspace", C.blue],
  [1, NF.folder, "src", C.blue],
  [2, NF.typescript, "main.ts", C.cyan],
  [2, NF.react, "app.tsx", C.cyan],
  [1, NF.folder, "docs", C.blue],
  [2, NF.markdown, "çalışma-notları.md", C.subtext],
  [2, NF.markdown, "İçerik.md", C.subtext],
  [1, NF.config, "package.json", C.yellow],
  [1, NF.lock, ".env.example", C.muted],
];

function Sidebar() {
  return (
    <box
      width={30}
      height="100%"
      flexDirection="column"
      backgroundColor={C.mantle}
      border
      borderStyle="rounded"
      borderColor={C.overlay}
      title=" Explorer "
      titleAlignment="left"
    >
      {tree.map(([indent, icon, name, color], i) => (
        <box key={name} height={1} backgroundColor={i === 2 ? C.surface : undefined}>
          <text fg={color}>
            {"  ".repeat(indent)}
            {icon} <span fg={i === 2 ? C.text : C.subtext}>{name}</span>
          </text>
        </box>
      ))}
    </box>
  );
}

function Styles() {
  const A = TextAttributes;
  return (
    <box flexDirection="column" paddingLeft={1}>
      <text fg={C.text}>
        <span attributes={A.BOLD}>bold</span> <span attributes={A.DIM}>dim</span>{" "}
        <span attributes={A.ITALIC}>italic</span> <span attributes={A.UNDERLINE}>underline</span>{" "}
        <span attributes={A.STRIKETHROUGH}>strike</span>{" "}
        <span fg={C.base} bg={C.yellow} attributes={A.BOLD | A.UNDERLINE}>
          {" combo "}
        </span>{" "}
        <span attributes={A.INVERSE}>inverse</span> <span fg={C.green}>{'<tag> & "quotes"'}</span>
      </text>
      <text fg={C.text}>
        Türkçe: <span fg={C.cyan}>Çalışma notları — ğüşöçİı ĞÜŞÖÇ</span>
      </text>
      <text fg={C.text}>
        Wide: <span fg={C.magenta}>漢字テスト</span> emoji <span>👍🚀</span> end|
      </text>
      <text fg={C.text}>
        Nerd: <span fg={C.blue}>{`${NF.folder} ${NF.branch} ${NF.github} ${NF.rust}`}</span> arrows → ❯ ✓ ✗ …
      </text>
    </box>
  );
}

const ANSI_SLOTS = Array.from({ length: 16 }, (_, i) => i);

function Palette() {
  return (
    <box flexDirection="column" paddingLeft={1}>
      <text>
        {ANSI_SLOTS.map((i) => (
          <span key={`slot-${i}`} bg={RGBA.fromIndex(i)} fg={RGBA.fromIndex(i < 8 ? 15 : 0)}>
            {` ${i.toString(16)} `}
          </span>
        ))}
        <span fg={RGBA.defaultForeground()} bg={RGBA.defaultBackground()}>
          {" default "}
        </span>
      </text>
      <text fg={C.cyan}>
        {"░░▒▒▓▓██▇▆▅▄▃▂▁ ▏▎▍▌▋▊▉█ ▖▗▘▝▚▞▙▟ "}
        <span fg={RGBA.fromIndex(208)}>{"indexed 208"}</span>
      </text>
    </box>
  );
}

function Boxes() {
  return (
    <box flexDirection="row" gap={1} paddingLeft={1} height={7}>
      <box width={18} border borderStyle="single" borderColor={C.blue} title="single">
        <text fg={C.subtext}>┌─┬─┐ ├─┼─┤</text>
        <text fg={C.subtext}>└─┴─┘ ╭───╮</text>
      </box>
      <box width={18} border borderStyle="double" borderColor={C.magenta} title="double">
        <text fg={C.subtext}>╔═╦═╗ ╠═╬═╣</text>
        <text fg={C.subtext}>╚═╩═╝ ║ ║ ║</text>
      </box>
      <box width={18} border borderStyle="heavy" borderColor={C.green} title="heavy">
        <text fg={C.subtext}>┏━┳━┓ ┣━╋━┫</text>
        <text fg={C.subtext}>┗━┻━┛ ┄┅┆┇╌</text>
      </box>
      <box width={18} border borderStyle="rounded" borderColor={C.yellow} title="rounded">
        <text fg={C.subtext}>╭─╮ ╱╲╳ ╒═╕</text>
        <text fg={C.subtext}>╰─╯ ╟─╢ ╘═╛</text>
      </box>
    </box>
  );
}

function StatusBar() {
  return (
    <box height={1} flexDirection="row" backgroundColor={C.mantle}>
      <text>
        <span fg={C.base} bg={C.blue} attributes={TextAttributes.BOLD}>
          {" NORMAL "}
        </span>
        <span fg={C.blue} bg={C.surface}>
          {NF.arrowRight}
        </span>
        <span fg={C.text} bg={C.surface}>
          {` ${NF.branch} main `}
        </span>
        <span fg={C.surface} bg={C.mantle}>
          {NF.arrowRight}
        </span>
        <span fg={C.subtext}>{"  src/app.tsx  ✓ 0  ✗ 2"}</span>
      </text>
      <box flexGrow={1} />
      <text>
        <span fg={C.surface}>{NF.arrowLeft}</span>
        <span fg={C.text} bg={C.surface}>
          {" UTF-8  Ln 12, Col 4 "}
        </span>
      </text>
    </box>
  );
}

export function TestScene() {
  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={C.base}>
      <box flexGrow={1} flexDirection="row">
        <Sidebar />
        <box
          flexGrow={1}
          flexDirection="column"
          border
          borderStyle="single"
          borderColor={C.overlay}
          title=" Screenshot test scene "
          gap={1}
        >
          <Styles />
          <Palette />
          <Boxes />
          <text fg={C.muted} paddingLeft={1}>
            {"The last rows sit under a translucent overlay: their colors must look darkened, not hidden."}
          </text>
          <text fg={C.yellow} paddingLeft={1}>
            {"███ yellow under the overlay ███  ŞİĞ 漢字 👍"}
          </text>
        </box>
      </box>
      <StatusBar />
      {/* Translucent backdrop over the right half, then an opaque dialog. */}
      <box position="absolute" left={64} top={18} width={56} height={16} backgroundColor="#00000099" />
      <box
        position="absolute"
        left={74}
        top={21}
        width={38}
        height={9}
        border
        borderStyle="double"
        borderColor={C.cyan}
        backgroundColor={C.surface}
        title=" Dialog "
        titleAlignment="center"
        flexDirection="column"
        paddingLeft={1}
      >
        <text fg={C.text}>Delete 3 files?</text>
        <text fg={C.subtext} attributes={TextAttributes.ITALIC}>
          This moves them to the trash.
        </text>
        <box height={1} />
        <text>
          <span fg={C.base} bg={C.red} attributes={TextAttributes.BOLD}>
            {" Delete "}
          </span>
          {"  "}
          <span fg={C.text} bg={C.overlay}>
            {" Cancel "}
          </span>
        </text>
      </box>
    </box>
  );
}
