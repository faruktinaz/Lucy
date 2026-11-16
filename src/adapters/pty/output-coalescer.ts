/**
 * Batches PTY output chunks.
 *
 * Bun delivers every PTY read as its own event-loop task, and macOS reads are tiny: 50 MiB from
 * `yes` arrives as ~600 000 chunks of ~90 bytes. Forwarding each one would run the emulator, the
 * sniffer and store updates 600 000 times. Microtasks and `setImmediate` do not batch across those
 * tasks; a 0 ms timer does (measured: 20 MiB in ~470 flushes). Memory stays bounded because a
 * batch is flushed synchronously once it reaches `maxBytes`, and backpressure still works: when the
 * consumer is slow the kernel PTY buffer fills and the child blocks on write.
 */
import type { Disposable } from "@/core/events";

export interface OutputCoalescerOptions {
  /** Flush immediately once this many bytes are pending. Default 256 KiB. */
  maxBytes?: number;
  /** Timer delay for a pending batch. Default 0 (next timer tick). */
  delayMs?: number;
}

const DEFAULT_MAX_BYTES = 256 * 1024;

export class OutputCoalescer implements Disposable {
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly maxBytes: number;
  private readonly delayMs: number;

  constructor(
    private readonly sink: (data: Uint8Array) => void,
    options: OutputCoalescerOptions = {},
  ) {
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.delayMs = Math.max(0, options.delayMs ?? 0);
  }

  get pendingByteCount(): number {
    return this.pendingBytes;
  }

  push(chunk: Uint8Array): void {
    if (this.disposed || chunk.byteLength === 0) return;
    this.pending.push(chunk);
    this.pendingBytes += chunk.byteLength;
    if (this.pendingBytes >= this.maxBytes) {
      this.flush();
      return;
    }
    if (this.timer === null) this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  /** Delivers everything pending now. Safe to call at any time. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pendingBytes === 0) return;
    const chunks = this.pending;
    const total = this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
    if (chunks.length === 1 && chunks[0]) {
      this.sink(chunks[0]);
      return;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.sink(out);
  }

  /** Drops pending output without delivering it. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
    this.pendingBytes = 0;
  }
}
