/**
 * Default keybindings.
 *
 * Conventions:
 * - The first chord is the familiar VS Code one. When it needs the kitty keyboard protocol
 *   (Ctrl+Shift+letter, Ctrl+Enter, Ctrl+`), a legacy-safe alternative follows, usually a
 *   `ctrl+k <letter>` sequence. A test asserts every command here has a legacy-safe chord
 *   (the leader's own "send the key through" binding is the one exception).
 * - `global: true` marks the escape hatches that still work while an embedded terminal has
 *   focus. Everything else falls through to the shell, so Ctrl+R reaches shell history
 *   search (Atuin) and Ctrl+P, Ctrl+C, Escape and Tab reach the program. The global set is:
 *   - F1, F6 and Shift+F6: shells and Claude Code leave function keys alone.
 *   - Kitty-only chords (Ctrl+Shift+letter, Ctrl+`): a legacy terminal cannot even send
 *     them, so they can never be mistaken for a key the shell expects.
 *   - The leader Ctrl+\ followed by one key: the guaranteed way out of a terminal in every
 *     terminal emulator. Ctrl+\ only sends SIGQUIT, which nobody presses on purpose in an
 *     interactive program; pressing it twice sends it through to the terminal anyway.
 * - A user override inherits `when` and `global` from the command's FIRST definition, so a
 *   command whose main chords are not global lists its non-global definition first.
 */
import { CONTEXT_KEYS } from "./context-keys";

export interface KeybindingDefinition {
  command: string;
  /** Chord sequences, preferred first. */
  keys: readonly string[];
  when?: string;
  /** Resolves even while the terminal has focus. Keep this set small. */
  global?: boolean;
  args?: unknown;
}

const { editorFocus, inputFocus, scmInputFocus, sidebarView } = CONTEXT_KEYS;

/** The leader chord; see the module comment. */
export const LEADER_KEY = "ctrl+\\";

const leader = (key: string) => `${LEADER_KEY} ${key}`;

export const DEFAULT_KEYBINDINGS: readonly KeybindingDefinition[] = [
  // Escape hatches that are also the main chords (work from inside the terminal).
  { command: "palette.show", keys: ["ctrl+shift+p", "f1", leader("p")], global: true },
  { command: "view.focusNextPart", keys: ["f6"], global: true },
  { command: "view.focusPreviousPart", keys: ["shift+f6"], global: true },
  { command: "terminal.toggle", keys: ["ctrl+`", leader("t")], global: true },
  { command: "terminal.toggle", keys: ["ctrl+k t"] },

  // Workbench.
  { command: "file.quickOpen", keys: ["ctrl+p"] },
  { command: "view.toggleSidebar", keys: ["ctrl+b"] },
  { command: "view.showExplorer", keys: ["ctrl+k e"] },
  { command: "view.showSearch", keys: ["ctrl+k f"] },
  { command: "view.showSourceControl", keys: ["ctrl+k g"] },
  { command: "view.toggleAiPanel", keys: ["ctrl+k a"] },
  { command: "view.focusAiPanel", keys: ["ctrl+l"] },
  { command: "view.toggleBottomPanel", keys: ["ctrl+j", "ctrl+k j"] },
  { command: "view.toggleMaximizedPanel", keys: ["ctrl+k m"] },
  { command: "view.toggleZenMode", keys: ["ctrl+k z"] },
  { command: "view.focusLeft", keys: ["ctrl+k left"] },
  { command: "view.focusDown", keys: ["ctrl+k down"] },
  { command: "view.focusUp", keys: ["ctrl+k up"] },
  { command: "view.focusRight", keys: ["ctrl+k right"] },
  { command: "view.increaseViewSize", keys: ["ctrl+k ="] },
  { command: "view.decreaseViewSize", keys: ["ctrl+k -"] },
  { command: "theme.select", keys: ["ctrl+k ctrl+t"] },
  { command: "settings.open", keys: ["ctrl+,", "ctrl+k ,"] },
  { command: "keybindings.open", keys: ["ctrl+k ctrl+s", "ctrl+k k"] },
  { command: "app.quit", keys: ["ctrl+q", "ctrl+k q"] },

  // Kitty-only accelerators: global, because a legacy terminal cannot send them at all.
  { command: "view.showExplorer", keys: ["ctrl+shift+e"], global: true },
  { command: "view.showSearch", keys: ["ctrl+shift+f"], global: true },
  { command: "view.showSourceControl", keys: ["ctrl+shift+g"], global: true },
  { command: "view.toggleAiPanel", keys: ["ctrl+shift+a"], global: true },

  // The leader: Ctrl+\ then one key, from anywhere, in every terminal.
  { command: "view.focusLeft", keys: [leader("h"), leader("left")], global: true },
  { command: "view.focusDown", keys: [leader("j"), leader("down")], global: true },
  { command: "view.focusUp", keys: [leader("k"), leader("up")], global: true },
  { command: "view.focusRight", keys: [leader("l"), leader("right")], global: true },
  { command: "view.showExplorer", keys: [leader("e")], global: true },
  { command: "view.showSearch", keys: [leader("f")], global: true },
  { command: "view.showSourceControl", keys: [leader("g")], global: true },
  { command: "view.focusAiPanel", keys: [leader("a")], global: true },
  { command: "app.quit", keys: [leader("q")], global: true },
  { command: "leader.sendKey", keys: [leader(LEADER_KEY)], global: true },

  // Editor.
  { command: "editor.find", keys: ["ctrl+f"], when: editorFocus },
  { command: "editor.goToLine", keys: ["ctrl+g"], when: editorFocus },
  { command: "editor.closeTab", keys: ["ctrl+w"], when: `!${inputFocus}` },
  { command: "editor.nextTab", keys: ["ctrl+pagedown"] },
  { command: "editor.previousTab", keys: ["ctrl+pageup"] },

  // Source control and AI.
  { command: "git.commit", keys: ["ctrl+enter"], when: scmInputFocus },
  { command: "git.commit", keys: ["ctrl+k c"], when: `${sidebarView} == 'scm'` },
  { command: "ai.newSession", keys: ["ctrl+k n"] },
];
