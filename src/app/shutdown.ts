/**
 * The single shutdown path (quit command, signals, fatal errors). Idempotent: the first call
 * runs every step once, later calls return the same promise. Each step is guarded, so one
 * failing step (a hung renderer, a full disk) never stops the others, and the process
 * always exits: OpenTUI's own signal handlers only destroy the renderer.
 */

export interface ShutdownSteps {
  /** Flush workspace state, dispose features and services (PTYs are killed here). */
  disposeApp(): Promise<void>;
  /** Synchronous safety net: kill every PTY tree that is still alive. */
  killTerminals(): void;
  /** Destroy the renderer and wait for `closed` (the terminal is restored). */
  destroyRenderer(): Promise<void>;
  /** Remove temporary files (demo workspace). */
  cleanup?(): void;
  flushLogs(): Promise<void>;
  /** Called last. */
  exit(code: number): void;
  /** Reports a failing step (to the log; the screen may be gone). */
  onStepError?(step: string, error: unknown): void;
}

const STEP_TIMEOUT_MS = 3000;

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class ShutdownController {
  private running: Promise<void> | null = null;
  private exitCode = 0;

  constructor(private readonly steps: ShutdownSteps) {}

  get started(): boolean {
    return this.running !== null;
  }

  /** Shuts down once; later calls (another signal, a second Ctrl+Q) return the same promise. */
  run(code = 0): Promise<void> {
    if (this.running) return this.running;
    this.exitCode = code;
    this.running = this.execute();
    return this.running;
  }

  private async step(name: string, action: () => void | Promise<void>): Promise<void> {
    try {
      await withTimeout(Promise.resolve().then(action), STEP_TIMEOUT_MS);
    } catch (error) {
      this.steps.onStepError?.(name, error);
    }
  }

  private async execute(): Promise<void> {
    const { steps } = this;
    await this.step("dispose app", () => steps.disposeApp());
    await this.step("kill terminals", () => steps.killTerminals());
    await this.step("destroy renderer", () => steps.destroyRenderer());
    await this.step("cleanup", () => steps.cleanup?.());
    await this.step("flush logs", () => steps.flushLogs());
    steps.exit(this.exitCode);
  }
}
