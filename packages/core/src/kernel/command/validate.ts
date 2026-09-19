import type { z } from "zod";
import { ValidationError } from "../../contracts/errors.ts";

export interface ValidatePayloadArgs {
  readonly schema: z.ZodType | null;
  readonly payload: unknown;
  readonly subject: string;
}

export interface ValidatePayloadFunction {
  (args: ValidatePayloadArgs): unknown;
}

/**
 * Validates a payload against a module's schema and returns the parsed value, so defaults and
 * transforms declared in the schema take effect. Without a schema the payload passes through.
 */
export const validatePayload: ValidatePayloadFunction = ({ schema, payload, subject }) => {
  if (schema === null) return payload ?? {};
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  return ((): never => {
    throw new ValidationError(
      `Invalid payload for ${subject}`,
      result.error.issues.map((issue) => ({
        path: issue.path.filter(
          (segment): segment is string | number => typeof segment !== "symbol",
        ),
        message: issue.message,
      })),
    );
  })();
};
