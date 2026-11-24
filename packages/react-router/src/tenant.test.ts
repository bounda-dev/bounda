import { ConfigurationError } from "@bounda-dev/core";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { tenantOfModule, tenantOfRequest } from "./tenant.ts";

const url = new URL("http://localhost/");
const args = {
  request: new Request(url),
  url,
  pattern: "/",
  params: {},
  context: new RouterContextProvider(),
};

describe("tenantOfModule", () => {
  it("takes the tenant app/tenant.ts exports, and refuses a module without one", async () => {
    const tenant = async () => "acme";
    expect(tenantOfModule({ tenant })).toBe(tenant);
    for (const module of [{}, { tenant: "acme" }, { default: tenant }]) {
      expect(() => tenantOfModule(module)).toThrow(
        new ConfigurationError(
          "app/tenant.ts does not export tenant, a function of the request that names its store",
        ),
      );
    }
  });
});

describe("tenantOfRequest", () => {
  it("names the request's tenant, awaited, and refuses anything but a non-empty string", async () => {
    expect(await tenantOfRequest(() => "acme", args)).toBe("acme");
    expect(await tenantOfRequest(async () => "globex", args)).toBe("globex");
    await expect(tenantOfRequest(() => undefined as unknown as string, args)).rejects.toThrow(
      new ConfigurationError(
        "tenant must name the store of a request with a non-empty string, got undefined",
      ),
    );
    await expect(tenantOfRequest(() => "", args)).rejects.toThrow(
      new ConfigurationError(
        'tenant must name the store of a request with a non-empty string, got ""',
      ),
    );
  });
});
