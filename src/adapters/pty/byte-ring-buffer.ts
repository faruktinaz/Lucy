/**
 * Fixed-capacity FIFO of bytes: keeps the most recent `capacity` bytes of terminal output.
 * Storage is allocated on first use, so idle sessions cost nothing.
 */
export class ByteRingBuffer {
  readonly capacity: number;
  private storage: Uint8Array | null = null;
  private start = 0;
  private length = 0;
  private dropped = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  /** Bytes currently held. */
  get size(): number {
    return this.length;
  }

  /** Total bytes evicted since creation or the last `clear()`. */
  get droppedBytes(): number {
    return this.dropped;
  }

  /**
   * Appends `chunk`, evicting the oldest bytes when full. `onEvict` receives evicted bytes in
   * stream order (as views that are only valid during the call).
   */
  push(chunk: Uint8Array, onEvict?: (evicted: Uint8Array) => void): void {
    if (chunk.byteLength === 0) return;
    this.storage ??= new Uint8Array(this.capacity);
    const storage = this.storage;
    if (chunk.byteLength >= this.capacity) {
      this.evict(this.length, onEvict);
      const skip = chunk.byteLength - this.capacity;
      if (skip > 0) {
        onEvict?.(chunk.subarray(0, skip));
        this.dropped += skip;
      }
      storage.set(chunk.subarray(skip));
      this.start = 0;
      this.length = this.capacity;
      return;
    }
    const overflow = this.length + chunk.byteLength - this.capacity;
    if (overflow > 0) this.evict(overflow, onEvict);
    let writeAt = (this.start + this.length) % this.capacity;
    const first = Math.min(chunk.byteLength, this.capacity - writeAt);
    storage.set(chunk.subarray(0, first), writeAt);
    if (first < chunk.byteLength) {
      writeAt = 0;
      storage.set(chunk.subarray(first), writeAt);
    }
    this.length += chunk.byteLength;
  }

  /** A copy of the held bytes, oldest first. */
  toBytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    if (!this.storage || this.length === 0) return out;
    const first = Math.min(this.length, this.capacity - this.start);
    out.set(this.storage.subarray(this.start, this.start + first));
    if (first < this.length) out.set(this.storage.subarray(0, this.length - first), first);
    return out;
  }

  clear(): void {
    this.start = 0;
    this.length = 0;
    this.dropped = 0;
  }

  private evict(count: number, onEvict?: (evicted: Uint8Array) => void): void {
    if (count <= 0 || !this.storage) return;
    const first = Math.min(count, this.capacity - this.start);
    onEvict?.(this.storage.subarray(this.start, this.start + first));
    if (first < count) onEvict?.(this.storage.subarray(0, count - first));
    this.start = (this.start + count) % this.capacity;
    this.length -= count;
    this.dropped += count;
  }
}
