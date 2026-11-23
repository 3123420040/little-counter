import type { FastifyReply } from "fastify";
import * as applicationNamespace from "@medusa-snus/application";

const applicationModule = ((applicationNamespace as unknown as {
  default?: typeof import("@medusa-snus/application");
}).default ?? applicationNamespace) as typeof import("@medusa-snus/application");

const { serializePlatformError } = applicationModule;

export function sendAiError(reply: FastifyReply, error: unknown) {
  const serialized = serializePlatformError(error);
  if (serialized.retryAfterSeconds) {
    reply.header("Retry-After", String(serialized.retryAfterSeconds));
  }
  return reply.status(serialized.statusCode).send(serialized.body);
}
