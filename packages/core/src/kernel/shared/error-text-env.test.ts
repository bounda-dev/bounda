import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../../contracts/errors.ts";
import { ERROR_TEXT_VARIABLE, errorTextFromEnv } from "./error-text-env.ts";

describe("errorTextFromEnv", () => {
  it("reads BOUNDA_ERROR_TEXT", () => {
    expect(ERROR_TEXT_VARIABLE).toBe("BOUNDA_ERROR_TEXT");
    expect(errorTextFromEnv({ BOUNDA_ERROR_TEXT: "include" })).toBe("include");
    expect(errorTextFromEnv({ BOUNDA_ERROR_TEXT: "omit" })).toBe("omit");
  });

  it("says nothing when it is unset or empty", () => {
    expect(errorTextFromEnv({})).toBeUndefined();
    expect(errorTextFromEnv({ BOUNDA_ERROR_TEXT: "" })).toBeUndefined();
    expect(errorTextFromEnv({ BOUNDA_ERROR_TEXT: undefined })).toBeUndefined();
  });

  it("refuses any other value", () => {
    expect(() => errorTextFromEnv({ BOUNDA_ERROR_TEXT: "yes" })).toThrow(
      new ConfigurationError('BOUNDA_ERROR_TEXT must be "omit" or "include", not "yes"'),
    );
    expect(() => errorTextFromEnv({ BOUNDA_ERROR_TEXT: true })).toThrow(ConfigurationError);
  });
});
