import type { z } from "zod";

/**
 * The Zod namespace, injected into every `payload`, `state` and similar schema function so user
 * modules never import the validator themselves.
 */
export type ZodApi = typeof z;

/**
 * Arguments of a schema function: `({ z }) => z.object({ ... })`.
 */
export interface PayloadArgs {
  readonly z: ZodApi;
}

/**
 * A schema function as exported from a user module.
 */
export type PayloadFunction<Schema extends z.ZodType = z.ZodType> = (args: PayloadArgs) => Schema;

/**
 * The payload type of a module without `payload`: an object with no keys.
 */
export type EmptyPayload = Record<never, never>;

/**
 * The output type of a schema function.
 */
export type InferPayload<F> = F extends (args: PayloadArgs) => infer Schema
  ? Schema extends z.ZodType
    ? z.output<Schema>
    : never
  : never;

/**
 * The input type of a schema function: what a caller passes before defaults and transforms apply.
 */
export type InferPayloadInput<F> = F extends (args: PayloadArgs) => infer Schema
  ? Schema extends z.ZodType
    ? z.input<Schema>
    : never
  : never;

/**
 * The payload type of a module: inferred from its `payload` export when present, empty otherwise.
 * This is what handlers receive, after validation.
 */
export type PayloadOf<Module> = Module extends { readonly payload: infer F }
  ? InferPayload<F>
  : EmptyPayload;

/**
 * The payload type a caller passes to a module's command or query: the schema's input, so fields
 * with defaults are optional.
 */
export type PayloadInputOf<Module> = Module extends { readonly payload: infer F }
  ? InferPayloadInput<F>
  : EmptyPayload;

/**
 * Whether a module declares a payload.
 */
export type HasPayload<Module> = Module extends { readonly payload: (args: PayloadArgs) => unknown }
  ? true
  : false;
