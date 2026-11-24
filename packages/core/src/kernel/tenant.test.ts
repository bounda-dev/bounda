import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../contracts/errors.ts";
import { DEFAULT_TENANT } from "./personal-data/tenant-keys.ts";
import { portTenantOf, tenantIdOf } from "./tenant.ts";

describe("the tenant's id", () => {
  it("is DEFAULT_TENANT for an app that names none, and the name of one that does", () => {
    expect(tenantIdOf(undefined)).toBe(DEFAULT_TENANT);
    expect(tenantIdOf(DEFAULT_TENANT)).toBe(DEFAULT_TENANT);
    expect(tenantIdOf("acme")).toBe("acme");
  });

  it("refuses an empty name, which names no tenant", () => {
    expect(() => tenantIdOf("")).toThrow(
      new ConfigurationError(
        "The tenant is named with an empty string: name it, or leave it out to serve default",
      ),
    );
  });

  it("reaches a port as none for DEFAULT_TENANT, and as itself otherwise", () => {
    expect(portTenantOf(DEFAULT_TENANT)).toBeUndefined();
    expect(portTenantOf("acme")).toBe("acme");
  });
});
