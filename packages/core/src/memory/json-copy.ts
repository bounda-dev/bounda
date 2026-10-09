export interface ToJsonFunction {
  (value: unknown): string;
}

export interface JsonCopyFunction {
  <Value>(value: Value): Value;
}

// Refuses what has no JSON, `undefined` included, as a SQL store refuses to bind it.
export const toJson: ToJsonFunction = (value) => {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError(`${String(value)} has no JSON to store`);
  return json;
};

// What a value reads back as once a SQL store has kept it as JSON: a fresh copy, dates as text.
export const jsonCopy: JsonCopyFunction = (value) => JSON.parse(toJson(value));
