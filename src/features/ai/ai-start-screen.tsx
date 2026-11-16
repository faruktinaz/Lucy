/**
 * The AI panel before any session exists. Honest about what will run: the resolved executable
 * and its version, the folder, and any risky argument in the user's settings. When the CLI is
 * missing it says so and shows how to install it, as text only.
 */
import type { ReactNode } from "react";
import type { AgentLaunchWarning } from "@/adapters/agents";
import { useApp, useStore } from "@/app/react";
import { tildify } from "@/core/paths";
import { sanitizeForDisplay, truncateStart } from "@/core/text";
import { Icon } from "@/ui/primitives/icon";
import { useMeasure } from "@/ui/primitives/measure";
import { Spinner } from "@/ui/primitives/spinner";
import { EmptyState, type StateAction } from "@/ui/primitives/states";
import { Label } from "@/ui/primitives/text";
import { useDensity, useTheme } from "@/ui/theme/theme-context";
import type { AiController } from "./ai-controller";

/** The documented way to install Claude Code, shown as text (Lucy never installs anything). */
const INSTALL_COMMAND = "npm install -g @anthropic-ai/claude-code";

/** What each kind of warning means, in a few words (the dialog shows the full message). */
const WARNING_EFFECT: Readonly<Record<AgentLaunchWarning["code"], string>> = {
  PERMISSION_BYPASS: "turns off permission prompts",
  PROMPT_ARGUMENT: "is sent as a prompt at start",
  NON_INTERACTIVE: "makes the session non-interactive",
  MODE_OVERRIDE: "changes which conversation opens",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  const density = useDensity();
  return (
    <box flexDirection="column" flexShrink={0} marginTop={density.sectionGap}>
      <Label variant="section">{title}</Label>
      {children}
    </box>
  );
}

/** Text the user may type in their own terminal: an inset line, like a field. */
function CommandLine({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <box flexShrink={0} backgroundColor={theme.colors.bg.inset} paddingX={1} marginTop={1}>
      <Label wrap>{text}</Label>
    </box>
  );
}

function Details({
  executable,
  version,
  problem,
}: {
  executable: string | null;
  version: string | null;
  problem: string | null;
}) {
  const app = useApp();
  const density = useDensity();
  const { size, onSizeChange } = useMeasure();
  // The measured box includes its own padding.
  const width = Math.max(8, size.width - density.rowPaddingX * 2);
  const path = (value: string) => truncateStart(sanitizeForDisplay(tildify(value)), width);
  return (
    <box flexDirection="column" paddingX={density.rowPaddingX} flexShrink={0} onSizeChange={onSizeChange}>
      {executable ? (
        <Section title="Executable">
          <Label>{path(executable)}</Label>
          {version ? <Label variant="secondary">{`Version ${sanitizeForDisplay(version)}`}</Label> : null}
          {problem ? (
            <Label tone="warning" wrap>
              {sanitizeForDisplay(problem)}
            </Label>
          ) : null}
        </Section>
      ) : null}
      <Section title="Folder">
        <Label>{path(app.workspace.root)}</Label>
      </Section>
      <box marginTop={density.sectionGap} flexShrink={0}>
        <Label variant="hint" wrap>
          Lucy runs your own CLI with your sign-in and permissions. It never adds permission flags and never
          sends a prompt for you.
        </Label>
      </box>
    </box>
  );
}

/** A prominent notice for risky configured arguments, in the toast card's visual language. */
function WarningBanner({ warnings }: { warnings: readonly AgentLaunchWarning[] }) {
  const theme = useTheme();
  const density = useDensity();
  const c = theme.colors;
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      marginTop={density.emptyStateTop}
      marginX={density.rowPaddingX}
      backgroundColor={c.bg.raised}
    >
      <box width={1} flexShrink={0} backgroundColor={c.status.warning} />
      <box flexDirection="column" flexGrow={1} paddingX={1} paddingY={1}>
        <Label bold wrap>
          <Icon name="warning" tone="warning" />
          Check your extra arguments
        </Label>
        {warnings.map((warning) => (
          <box key={`${warning.code}-${warning.arg}`} flexDirection="column" marginTop={1} flexShrink={0}>
            <Label wrap>{sanitizeForDisplay(warning.arg)}</Label>
            <Label variant="secondary" wrap>
              {WARNING_EFFECT[warning.code]}
            </Label>
          </box>
        ))}
        <box marginTop={1} flexShrink={0}>
          <Label variant="hint" wrap>
            From ai.args. Starting asks you to confirm.
          </Label>
        </box>
      </box>
    </box>
  );
}

function launchActions(controller: AiController, defaultMode: string): StateAction[] {
  const name = controller.providerName();
  const start: StateAction = { label: `Start ${name}`, command: "ai.newSession" };
  const resume: StateAction = { label: "Resume a session…", command: "ai.resumeSession" };
  const last: StateAction = { label: "Continue last session", command: "ai.continueSession" };
  return defaultMode === "continue" ? [last, start, resume] : [start, last, resume];
}

export function AiStartScreen({ controller }: { controller: AiController }) {
  const app = useApp();
  const density = useDensity();
  const detection = useStore(controller.store, (state) => state.detection);
  const defaultMode = useStore(app.config.store, (config) => config.ai.defaultMode);
  const name = controller.providerName();

  if (detection.kind === "unchecked" || detection.kind === "checking") {
    return (
      <box flexDirection="column" paddingX={density.rowPaddingX} paddingTop={density.emptyStateTop}>
        <Label variant="secondary">
          <Spinner label={`Looking for ${name}`} />
        </Label>
      </box>
    );
  }
  if (detection.kind === "no-provider") {
    return (
      <EmptyState
        title="No coding agent is configured"
        description="Lucy has no AI provider to start in this panel."
        actions={[{ label: "Open Settings", command: "settings.open" }]}
      />
    );
  }

  const { detection: found, warnings } = detection;
  if (!found.available) {
    return (
      <box flexDirection="column" flexGrow={1}>
        <EmptyState
          title={`${name} was not found`}
          description={sanitizeForDisplay(found.problem ?? `Lucy could not start ${name}.`)}
          actions={[
            { label: "Check again", onPress: () => void controller.refreshDetection() },
            { label: "Open Settings", command: "settings.open" },
          ]}
        />
        <box flexDirection="column" paddingX={density.rowPaddingX} flexShrink={0}>
          <Section title="Install">
            <CommandLine text={INSTALL_COMMAND} />
            <box marginTop={1} flexShrink={0}>
              <Label variant="secondary" wrap>
                Then run claude once in a terminal to sign in, and choose Check again.
              </Label>
            </box>
          </Section>
          <Section title="Installed elsewhere">
            <Label variant="secondary" wrap>
              Set ai.executable in Settings to the full path of claude.
            </Label>
          </Section>
        </box>
      </box>
    );
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      {warnings.length > 0 ? <WarningBanner warnings={warnings} /> : null}
      <EmptyState
        title="No session is running"
        description={`${name} runs here, beside your files. Changes it makes appear in the explorer and Source Control.`}
        actions={launchActions(controller, defaultMode)}
      />
      <Details executable={found.executable} version={found.version} problem={found.problem} />
    </box>
  );
}
