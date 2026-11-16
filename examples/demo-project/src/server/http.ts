import { ValidationError } from "../shared/validation";

/** An error that maps directly to an HTTP response with a stable error code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export async function readJson(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "expected an application/json body");
  }
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "invalid_json", "request body is not valid JSON");
  }
}

export function notFound(what: string): HttpError {
  return new HttpError(404, "not_found", `${what} was not found`);
}

/** The single place where thrown errors become responses. */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ error: { code: error.code, message: error.message } }, error.status, error.headers);
  }
  if (error instanceof ValidationError) {
    return json({ error: { code: "validation_failed", message: error.message } }, 422);
  }
  console.error("Unhandled error", error);
  return json({ error: { code: "internal", message: "Something went wrong" } }, 500);
}
