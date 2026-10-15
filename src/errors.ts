/** Base class for every error this SDK raises. */
export class NornsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NornsError";
  }
}

/** The Norns API answered with a non-2xx status. */
export class NornsApiError extends NornsError {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `Norns API error ${status}: ${describeBody(body)}`);
    this.name = "NornsApiError";
    this.status = status;
    this.body = body;
  }
}

/** The thing asked for does not exist (404). */
export class NotFoundError extends NornsApiError {
  constructor(what: string, body: unknown = undefined) {
    super(404, body, `${what} not found`);
    this.name = "NotFoundError";
  }
}

/** A wait or a stream ran out of time. */
export class NornsTimeoutError extends NornsError {
  constructor(message: string) {
    super(message);
    this.name = "NornsTimeoutError";
  }
}

/**
 * The worker's channel join was rejected for a reason a retry cannot fix:
 * a bad claim token, a destroyed or missing gard, an invalid registration.
 */
export class JoinError extends NornsError {
  readonly reason: string;
  readonly code: string | undefined;

  constructor(reason: string, code?: string) {
    super(`worker join rejected: ${reason}${code ? ` (${code})` : ""}`);
    this.name = "JoinError";
    this.reason = reason;
    this.code = code;
  }
}

/** The gard this worker claimed was destroyed while it was connected. */
export class GardDestroyedError extends NornsError {
  constructor(gard: string | number | undefined) {
    super(`gard ${gard ?? "?"} was destroyed`);
    this.name = "GardDestroyedError";
  }
}

/** A stream's socket closed before the run reached a terminal event. */
export class StreamClosedError extends NornsError {
  readonly reason: unknown;

  constructor(reason: unknown) {
    super(`stream closed before the run finished: ${describeBody(reason)}`);
    this.name = "StreamClosedError";
    this.reason = reason;
  }
}

function describeBody(body: unknown): string {
  if (typeof body === "string") return body;
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error: unknown }).error;
    return typeof err === "string" ? err : JSON.stringify(err);
  }
  if (body instanceof Error) return body.message;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

/** A readable message for anything thrown. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return describeBody(err);
}
