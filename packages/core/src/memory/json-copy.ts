export interface JsonCopyFunction {
  <Value>(value: Value): Value;
}

// What a value reads back as once a SQL store has kept it as JSON: a fresh copy, dates as text.
export const jsonCopy: JsonCopyFunction = (value) =>
  value === undefined ? value : JSON.parse(JSON.stringify(value));
