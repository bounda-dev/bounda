import { describe, expect, it } from "vitest";
import type { Config, ErrorText } from "../../config/types.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import { ERROR_TEXT_VARIABLE, resolveErrorText, withErrorText } from "./error-text.ts";

const configured = (errorText?: ErrorText): Config => ({
  storage: memory(),
  ...(errorText === undefined ? {} : { runtime: { telemetry: { errorText } } }),
});

describe("resolveErrorText", () => {
  it("names BOUNDA_ERROR_TEXT", () => {
    expect(ERROR_TEXT_VARIABLE).toBe("BOUNDA_ERROR_TEXT");
  });

  // forced, BOUNDA_ERROR_TEXT, configuration, fallback → rule
  it.each([
    [undefined, undefined, undefined, undefined, "omit"],
    [undefined, undefined, undefined, "include", "include"],
    [undefined, undefined, "include", "omit", "include"],
    [undefined, undefined, "omit", "include", "omit"],
    [undefined, "include", "omit", "omit", "include"],
    [undefined, "omit", "include", "include", "omit"],
    [undefined, "", "include", undefined, "include"],
    ["omit", "include", "include", "include", "omit"],
    ["include", "omit", "omit", "omit", "include"],
  ] as const)(
    "forced %s over BOUNDA_ERROR_TEXT %j over the configuration's %s over the fallback %s: %s",
    (forced, variable, errorText, fallback, rule) => {
      const args = {
        forced,
        env: variable === undefined ? {} : { BOUNDA_ERROR_TEXT: variable },
        config: configured(errorText),
        fallback,
      };
      expect(resolveErrorText(args)).toBe(rule);
      expect(withErrorText(args).runtime?.telemetry?.errorText).toBe(rule);
    },
  );

  it("reads no environment and no configuration it is not given", () => {
    expect(resolveErrorText({})).toBe("omit");
    expect(resolveErrorText({ config: { storage: memory(), runtime: { role: "web" } } })).toBe(
      "omit",
    );
    expect(resolveErrorText({ fallback: "include" })).toBe("include");
  });

  it("refuses a BOUNDA_ERROR_TEXT it does not know, unless told to ignore it", () => {
    const env = { BOUNDA_ERROR_TEXT: "yes" };
    expect(() => resolveErrorText({ env })).toThrow(
      new ConfigurationError('BOUNDA_ERROR_TEXT must be "omit" or "include", not "yes"'),
    );
    expect(() => resolveErrorText({ env: { BOUNDA_ERROR_TEXT: true } })).toThrow(
      ConfigurationError,
    );
    expect(resolveErrorText({ env, config: configured("include"), ignoreInvalidEnv: true })).toBe(
      "include",
    );
    expect(resolveErrorText({ env, forced: "include" })).toBe("include");
  });
});

describe("withErrorText", () => {
  it("keeps the rest of the configuration", () => {
    const config: Config = {
      storage: memory(),
      runtime: { role: "web", telemetry: { errorText: "omit" } },
    };
    expect(withErrorText({ config, forced: "include" })).toEqual({
      storage: config.storage,
      runtime: { role: "web", telemetry: { errorText: "include" } },
    });
    expect(config.runtime?.telemetry?.errorText).toBe("omit");
  });
});
