/**
 * A query as a handler receives it: type and validated payload.
 */
export interface Query<Type extends string = string, Payload = unknown> {
  readonly type: Type;
  readonly payload: Payload;
}
