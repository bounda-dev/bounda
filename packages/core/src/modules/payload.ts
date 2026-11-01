import type { z } from "zod";
import type { CommandPersonalFunction, PersonalFunction, PersonFunction } from "./personal.ts";

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

export type PayloadFunction<Schema extends z.ZodType = z.ZodType> = (args: PayloadArgs) => Schema;

/**
 * Arguments of an event's `payload`: `z`, and `personal` and `person` to mark the fields that
 * hold personal data and the one that names whose it is.
 */
export interface EventPayloadArgs extends PayloadArgs {
  readonly personal: PersonalFunction;
  readonly person: PersonFunction;
}

export type EventPayloadFunction<Schema extends z.ZodType = z.ZodType> = (
  args: EventPayloadArgs,
) => Schema;

/**
 * Arguments of a command's `payload`: `z`, and `personal` and `person` to mark the fields that
 * hold personal data and the one that names whose it is, for when the command is stored.
 */
export interface CommandPayloadArgs extends PayloadArgs {
  readonly personal: CommandPersonalFunction;
  readonly person: PersonFunction;
}

export type CommandPayloadFunction<Schema extends z.ZodType = z.ZodType> = (
  args: CommandPayloadArgs,
) => Schema;

/**
 * The payload type of a module without `payload`: an object with no keys.
 */
export type EmptyPayload = Record<never, never>;

export type InferPayload<F> = F extends (args: never) => infer Schema
  ? Schema extends z.ZodType
    ? z.output<Schema>
    : never
  : never;

export type InferPayloadInput<F> = F extends (args: never) => infer Schema
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

export type HasPayload<Module> = Module extends { readonly payload: (args: never) => unknown }
  ? true
  : false;
