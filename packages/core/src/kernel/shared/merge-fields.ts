export interface IsRecordFunction {
  (value: unknown): value is Readonly<Record<string, unknown>>;
}

export const isRecord: IsRecordFunction = (value): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface MergeFieldsFunction {
  (state: object, fields: Readonly<Record<string, unknown>>): object;
}

// Shallow, as `Partial<State>` types it: a nested object is replaced whole, and a field left
// `undefined` counts as left out, so it keeps its value.
export const mergeFields: MergeFieldsFunction = (state, fields) => ({
  ...state,
  ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
});
