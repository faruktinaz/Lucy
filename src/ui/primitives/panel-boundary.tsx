/**
 * A per-panel error boundary. OpenTUI's root boundary replaces the WHOLE app with a stack
 * trace (OPENTUI_NOTES §13), so every view is wrapped in one of these: a broken view shows a
 * calm error state with Retry, and the rest of the workbench keeps working.
 */
import { Component, type ErrorInfo, Fragment, type ReactNode } from "react";
import { errorMessage } from "@/core/errors";
import type { Logger } from "@/core/log";
import { ErrorState } from "./states";

export interface PanelBoundaryProps {
  /** Shown in the error title: "Explorer stopped working". */
  name: string;
  children: ReactNode;
  log?: Logger;
  /** Where the log is, for the error message. */
  logPath?: string;
  /** Called after Retry, before the children are mounted again. */
  onReset?: () => void;
}

interface State {
  error: unknown;
  attempt: number;
}

export class PanelBoundary extends Component<PanelBoundaryProps, State> {
  override state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.log?.error(`View "${this.props.name}" failed to render`, {
      error,
      componentStack: info.componentStack ?? undefined,
    });
  }

  private readonly retry = () => {
    this.props.onReset?.();
    this.setState((state) => ({ error: null, attempt: state.attempt + 1 }));
  };

  override render(): ReactNode {
    if (this.state.error !== null) {
      const where = this.props.logPath ? ` Details are in ${this.props.logPath}.` : "";
      return (
        <ErrorState
          title={`${this.props.name} stopped working`}
          message={`${errorMessage(this.state.error).replace(/\.?$/, ".")}${where}`}
          actions={[{ label: "Retry", icon: "arrowRight", onPress: this.retry }]}
        />
      );
    }
    // A new key remounts the subtree from scratch after Retry.
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}
