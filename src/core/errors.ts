/**
 * Every failure the UI may need to explain to the user is a `LucyError` with a stable
 * `code`. The UI maps codes to calm, human-readable messages; nothing fails silently.
 */
export type LucyErrorCode =
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "PERMISSION_DENIED"
  | "OUTSIDE_WORKSPACE"
  | "INVALID_ARGUMENT"
  | "UNSUPPORTED"
  | "TOO_LARGE"
  | "BINARY_FILE"
  | "TIMEOUT"
  | "CANCELLED"
  | "SPAWN_FAILED"
  | "PROCESS_FAILED"
  | "NOT_A_REPOSITORY"
  | "GIT_FAILED"
  | "CONFIG_INVALID"
  | "IO_ERROR"
  | "INTERNAL";

export class LucyError extends Error {
  readonly code: LucyErrorCode;
  /** Extra machine-readable context. Must never contain secrets. */
  readonly details?: Record<string, unknown>;

  constructor(
    code: LucyErrorCode,
    message: string,
    options?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LucyError";
    this.code = code;
    this.details = options?.details;
  }
}

export function isLucyError(error: unknown, code?: LucyErrorCode): error is LucyError {
  return error instanceof LucyError && (code === undefined || error.code === code);
}

/** Best-effort short message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

/** Maps a Node/Bun filesystem error to a `LucyError`, preserving the original as `cause`. */
export function fromFsError(error: unknown, path: string): LucyError {
  const code = (error as { code?: string } | null)?.code;
  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
      return new LucyError("NOT_FOUND", `Not found: ${path}`, { cause: error });
    case "EEXIST":
    case "ENOTEMPTY":
      return new LucyError("ALREADY_EXISTS", `Already exists: ${path}`, { cause: error });
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return new LucyError("PERMISSION_DENIED", `Permission denied: ${path}`, { cause: error });
    default:
      return new LucyError("IO_ERROR", `${errorMessage(error)} (${path})`, { cause: error });
  }
}
