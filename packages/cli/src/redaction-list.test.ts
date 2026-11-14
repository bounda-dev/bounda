import { describe, expect, it } from "vitest";
import { parseRedactionList } from "./redaction-list.ts";

const target = {
  aggregateType: "customer",
  aggregateId: "c-1",
  type: "CustomerRegistered",
  id: "e-1",
  fields: ["email"],
};

const line = (value: unknown): string => JSON.stringify(value);

describe("parseRedactionList", () => {
  it("reads one event a line, skipping blank lines and keeping what each names alone", () => {
    expect(
      parseRedactionList(
        `${line({ ...target, extra: "x" })}\r\n\n  ${line({ ...target, id: "e-2", fields: ["email", "phone"] })}  \n`,
      ),
    ).toEqual([target, { ...target, id: "e-2", fields: ["email", "phone"] }]);
    expect(parseRedactionList("")).toEqual([]);
  });

  it("names the first line that is not one, never what it holds", () => {
    const cases: readonly [string, string][] = [
      ["Ana Wrongname", "line 2 is not JSON"],
      ["[]", "line 2 is not an object"],
      ["null", "line 2 is not an object"],
      ['"text"', "line 2 is not an object"],
      ...["aggregateType", "aggregateId", "type", "id"].flatMap((name): [string, string][] =>
        [undefined, "", 7].map((value) => [
          line({ ...target, [name]: value }),
          "line 2 needs the event's aggregateType, aggregateId, type and id",
        ]),
      ),
      ...[undefined, [], "email", ["email", ""], ["email", 1]].map((fields): [string, string] => [
        line({ ...target, fields }),
        "line 2 needs the fields to redact, as a list of names",
      ]),
    ];
    for (const [second, message] of cases) {
      expect(() => parseRedactionList(`${line(target)}\n${second}`)).toThrow(message);
      try {
        parseRedactionList(`${line(target)}\n${second}`);
      } catch (error) {
        expect((error as Error).message).toBe(message);
      }
    }
  });
});
