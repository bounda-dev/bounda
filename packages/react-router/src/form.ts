import { createElement, type ReactElement } from "react";
import { IDEMPOTENCY_KEY_FIELD } from "./idempotency-key.ts";

export interface CreateIdempotencyKeyFunction {
  (): string;
}

/**
 * A fresh idempotency key, a random UUID, for a loader to hand to `IdempotencyKeyField`. Made on
 * the server, so the page hydrates with the key it was rendered with.
 */
export const createIdempotencyKey: CreateIdempotencyKeyFunction = () => crypto.randomUUID();

export interface IdempotencyKeyFieldProps {
  /**
   * The key the loader made with `createIdempotencyKey`.
   */
  readonly value: string;
}

export interface IdempotencyKeyFieldFunction {
  (props: IdempotencyKeyFieldProps): ReactElement;
}

export interface RenewOnInputFunction {
  (input: HTMLInputElement): () => void;
}

// A form edited after an answer is another request, which a key it already used would turn into
// a conflict: React Router does not run the loader again after an action that answers 4xx, so the
// field takes a fresh key itself once the user changes anything.
export const renewOnInput: RenewOnInputFunction = (input) => {
  const form = input.form;
  if (form === null) return () => {};
  const renew = () => {
    input.value = createIdempotencyKey();
  };
  form.addEventListener("input", renew);
  return () => form.removeEventListener("input", renew);
};

/**
 * A hidden `idempotencyKey` field for a `<Form>` whose action dispatches commands: the middleware
 * keys every command of the request with it, as it does with the `Idempotency-Key` header, which
 * it prefers. A form sent again unchanged, after a lost response or a double submit, answers what
 * the first submit did; once the user edits the form, the field holds a fresh key, and a new key
 * from the loader replaces it.
 *
 * @example
 * export const loader = () => ({ idempotencyKey: createIdempotencyKey() });
 *
 * <Form method="post">
 *   <IdempotencyKeyField value={loaderData.idempotencyKey} />
 * </Form>
 */
export const IdempotencyKeyField: IdempotencyKeyFieldFunction = ({ value }) =>
  createElement("input", {
    key: value,
    ref: renewOnInput,
    type: "hidden",
    name: IDEMPOTENCY_KEY_FIELD,
    defaultValue: value,
  });
