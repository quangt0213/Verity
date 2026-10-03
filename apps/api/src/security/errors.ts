import type { ApiErrorCode } from "@verity/contracts";
import type { FastifyError, FastifyInstance } from "fastify";
import { z } from "zod";

/** An error whose message is safe to show to any client. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly fields?: Record<string, string>;
  readonly retryAfterSeconds?: number;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    extra: { fields?: Record<string, string>; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = extra.fields;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }
}

export const notFound = (what = "Not found") => new ApiError(404, "not_found", what);
export const authRequired = () => new ApiError(401, "auth_required", "Sign in to contribute.");

/** Validate untrusted input with a shared contract schema, mapping failures to field errors. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join(".") || "_";
    fields[key] ??= issue.code === "unrecognized_keys" ? "Unexpected field" : issue.message.slice(0, 200);
  }
  throw new ApiError(400, "validation_failed", "Some fields are invalid.", { fields });
}

const FASTIFY_CODES: Record<string, { status: number; code: ApiErrorCode; message: string }> = {
  FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, code: "payload_too_large", message: "Request body is too large." },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { status: 415, code: "validation_failed", message: "Send JSON with Content-Type: application/json." },
  FST_ERR_CTP_EMPTY_JSON_BODY: { status: 400, code: "validation_failed", message: "Request body is required." },
  FST_ERR_CTP_INVALID_JSON_BODY: { status: 400, code: "validation_failed", message: "Request body is not valid JSON." },
};

/**
 * The only error shape clients ever see: { error: { code, message, request_id } }.
 * Stack traces, SQL errors and provider messages are logged server-side only.
 */
export function registerErrorHandling(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError | ApiError | Error, request, reply) => {
    const requestId = request.id;
    if (error instanceof ApiError) {
      if (error.retryAfterSeconds) reply.header("Retry-After", String(error.retryAfterSeconds));
      return reply.status(error.status).send({
        error: { code: error.code, message: error.message, request_id: requestId, ...(error.fields ? { fields: error.fields } : {}) },
      });
    }
    const known = "code" in error && typeof error.code === "string" ? FASTIFY_CODES[error.code] : undefined;
    if (known) {
      return reply.status(known.status).send({ error: { code: known.code, message: known.message, request_id: requestId } });
    }
    if ("statusCode" in error && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: "validation_failed", message: "The request could not be processed.", request_id: requestId } });
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal", message: "Something went wrong.", request_id: requestId } });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({ error: { code: "not_found", message: "Not found.", request_id: request.id } }),
  );
}
