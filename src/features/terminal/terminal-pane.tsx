/**
 * One embedded terminal bound to one `TerminalSession`, shared by the Terminal panel and the
 * AI panel.
 *
 * Lifetime rules (docs/dev/PTY_NOTES.md §5.1, §5.9): the parent renders one pane per session
 * for the session's whole life and hides it with `visible={false}`; unmounting destroys the
 * emulator. The pane connects the renderable before it starts the process, so the program's
 * first terminal queries (DA1, kitty `CSI ? u`, OSC 11) are answered live.
 */
import type { EmbeddedTerminalRenderable, KeyEvent, PasteEvent } from "@opentui/core";
import { useEffect, useRef, useState } from "react";
import { connectEmbeddedTerminal, type TerminalSession } from "@/adapters/pty";
import { LEADER_CHORD, registerTerminalRenderable } from "@/app/input/key-router";
import { useApp, useFocusTarget, useStore, useZoneFocused } from "@/app/react";
import { DisposableStore, toDisposable } from "@/core/events";
import { sanitizeForDisplay } from "@/core/text";
import { useDensity, useTheme } from "@/ui/theme/theme-context";
import { planPaste, scrollbackBytes, terminalColorPrelude } from "./terminal-colors";
import { TerminalExitBar } from "./terminal-exit-bar";

export interface TerminalPaneProps {
  session: TerminalSession;
  /** Shown in its container right now (hidden panes keep running and answering queries). */
  visible: boolean;
  /** The pane that receives renderable focus when its zone is focused. */
  active: boolean;
  /** What runs in it, for messages: "Claude Code", "zsh". */
  name: string;
  onRestart: () => void;
  onClose: () => void;
}

/**
 * Writes `apply` into the emulator only between escape sequences: a colour prelude injected
 * in the middle of a sequence the program is sending would corrupt both.
 */
function whenAtBoundary(session: TerminalSession, apply: () => void): () => void {
  if (session.atSequenceBoundary) {
    apply();
    return () => {};
  }
  const subscription = session.onOutput(() => {
    if (!session.atSequenceBoundary) return;
    subscription.dispose();
    apply();
  });
  return () => subscription.dispose();
}

export function TerminalPane({ session, visible, active, name, onRestart, onClose }: TerminalPaneProps) {
  const app = useApp();
  const theme = useTheme();
  const density = useDensity();
  const zoneFocused = useZoneFocused();
  const ref = useRef<EmbeddedTerminalRenderable>(null);
  const latest = useRef({ name, onRestart, onClose, theme });
  latest.current = { name, onRestart, onClose, theme };
  const status = useStore(session.state, (state) => state.status);
  // Constructor-only options: the emulator cannot change them later.
  const [initial] = useState(() => ({
    cols: session.state.get().cols,
    rows: session.state.get().rows,
    maxScrollback: scrollbackBytes(app.config.get("terminal.scrollback")),
  }));

  useFocusTarget(ref, active);

  // Switching tabs inside a focused zone moves renderable focus to the newly active pane.
  useEffect(() => {
    if (active && zoneFocused) ref.current?.focus();
  }, [active, zoneFocused]);

  useEffect(() => {
    const term = ref.current;
    if (!term) return;
    const store = new DisposableStore();
    const owner = {};
    store.add(registerTerminalRenderable(term));
    store.add(
      connectEmbeddedTerminal(session, term, {
        screenPrelude: () => terminalColorPrelude(latest.current.theme.terminal),
      }),
    );

    // While a terminal has the keyboard, the hint area says how to get out.
    const onFocused = () => app.hints.setAmbient(owner, { text: "Leave the terminal", keys: LEADER_CHORD });
    const onBlurred = () => app.hints.setAmbient(owner, null);
    term.on("focused", onFocused);
    term.on("blurred", onBlurred);
    if (term.focused) onFocused();
    store.add(
      toDisposable(() => {
        term.off("focused", onFocused);
        term.off("blurred", onBlurred);
        app.hints.setAmbient(owner, null);
      }),
    );

    term.onPaste = (event: PasteEvent) => {
      const plan = planPaste(event.bytes, session.modes.bracketedPaste);
      if (plan.kind === "default") return;
      event.preventDefault();
      if (plan.kind === "paste") {
        session.paste(plan.text);
        return;
      }
      const label = latest.current.name;
      void app.dialogs
        .confirm({
          title: `Paste ${plan.lines} lines into ${label}?`,
          message: `${label} has not turned on bracketed paste, so each line runs as soon as it arrives. The last line is pasted without Enter.`,
          confirmLabel: "Paste",
        })
        .then((confirmed) => {
          if (confirmed) session.paste(plan.text);
          ref.current?.focus();
        });
    };

    // After the process ended the terminal has nothing to receive keys: Enter restarts and
    // Ctrl+W closes, as the exit bar says. Everything else is ignored.
    term.onKeyDown = (key: KeyEvent) => {
      const current = session.state.get().status;
      if (current !== "exited" && current !== "failed") return;
      if (key.name === "return" || key.name === "enter") {
        key.preventDefault();
        latest.current.onRestart();
      } else if (key.ctrl && !key.shift && key.name === "w") {
        key.preventDefault();
        latest.current.onClose();
      }
    };
    store.add(
      toDisposable(() => {
        term.onPaste = undefined;
        term.onKeyDown = undefined;
      }),
    );

    // Connected: start the process now, so its first queries reach a live emulator.
    if (!session.hasStarted) session.start();
    return () => store.dispose();
  }, [app, session]);

  // Theme changes restyle the terminal: new default colours and ANSI palette.
  const revision = theme.revision;
  const firstRevision = useRef(revision);
  useEffect(() => {
    if (revision === firstRevision.current) return;
    const term = ref.current;
    if (!term) return;
    return whenAtBoundary(session, () => term.write(terminalColorPrelude(latest.current.theme.terminal)));
  }, [revision, session]);

  const ended = status === "exited" || status === "failed";
  return (
    <box
      visible={visible}
      flexGrow={1}
      minHeight={0}
      minWidth={0}
      flexDirection="column"
      backgroundColor={theme.colors.terminal.bg}
      paddingLeft={density.rowPaddingX}
    >
      <embedded-terminal
        ref={ref}
        width="100%"
        height="100%"
        cols={initial.cols}
        rows={initial.rows}
        maxScrollback={initial.maxScrollback}
      />
      {ended ? (
        <TerminalExitBar
          name={sanitizeForDisplay(name)}
          session={session}
          onRestart={onRestart}
          onClose={onClose}
        />
      ) : null}
    </box>
  );
}
