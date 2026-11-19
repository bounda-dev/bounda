import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { Registry } from "../../modules/registry.ts";
import { buildPersonalCategories } from "../personal-data/categories.ts";
import { bindReturns, buildPortReturns, type ReturnedRead } from "./returns.ts";

const categories = buildPersonalCategories({
  module: {
    categories: {
      contact: {
        basis: "contract",
        retention: "30d",
        purposes: ["Reach the customer"],
        sources: ["data-subject"],
      },
    },
    automatedDecisions: {},
  } as never,
  retention: null,
});

const registryOf = (
  returnsPersonalData: unknown,
  ports: Readonly<Record<string, unknown>> = { crm: { memory: { default: {} } } },
): Registry =>
  ({
    aggregates: {
      customer: {
        events: {},
        ports,
        returns: { crm: { returnsPersonalData } },
        commands: {},
        policies: {},
        processes: {},
      },
    },
    readModels: {},
  }) as unknown as Registry;

const built = (returnsPersonalData: unknown) =>
  buildPortReturns({ registry: registryOf(returnsPersonalData), categories });

const persons = ({ result }: { result: { id: string } }) => result.id;

describe("buildPortReturns", () => {
  it("keeps the ports whose calls return someone's data, with the default category", () => {
    expect(built(false).byOwner).toEqual({});
    expect(built({ find: false }).byOwner).toEqual({});
    expect(built({ persons }).byOwner).toEqual({
      customer: { crm: { call: { persons, personsOnError: undefined, categories: ["default"] } } },
    });
    expect(built({ find: { persons, categories: ["contact"] }, ping: false }).byOwner).toEqual({
      customer: {
        crm: {
          methods: {
            find: { persons, personsOnError: undefined, categories: ["contact"] },
          },
        },
      },
    });
    expect(
      buildPortReturns({
        registry: { aggregates: {}, readModels: { r: { returns: {} } } } as unknown as Registry,
        categories,
      }).byOwner,
    ).toEqual({});
  });

  it("refuses a declaration that says nothing it can read", () => {
    const refused = (declared: unknown, message: string) =>
      expect(() => built(declared)).toThrow(new ConfigurationError(message));
    const prefix = "Port customer.crm: returnsPersonalData";
    refused(
      true,
      `${prefix} must be false, what the port returns, or an object of what each method returns`,
    );
    refused(
      [],
      `${prefix} must be false, what the port returns, or an object of what each method returns`,
    );
    refused(
      null,
      `${prefix} must be false, what the port returns, or an object of what each method returns`,
    );
    refused(
      { find: true },
      `${prefix}.find must be false or what the method returns: { persons, categories }`,
    );
    refused(
      { find: {} },
      `${prefix}.find: persons must be a function of the call, naming whose personal data it returned`,
    );
    refused(
      { persons, personsOnError: 1 },
      `${prefix}: personsOnError must be a function of the failed call, naming whose data its error may quote`,
    );
    refused(
      { persons, categories: [] },
      `${prefix}: categories must list the categories of the personal data returned`,
    );
    refused(
      { persons, categories: "contact" },
      `${prefix}: categories must list the categories of the personal data returned`,
    );
    refused(
      { persons, categories: ["marketing"] },
      `${prefix}: categories names "marketing", which the app does not have`,
    );
    refused(
      { persons, categories: [1] },
      `${prefix}: categories names 1, which the app does not have`,
    );
    refused(
      { persons, categories: ["contact", "contact"] },
      `${prefix}: categories names a category twice`,
    );
  });

  it("refuses a port that declares what it returns and has no implementation", () => {
    expect(() => buildPortReturns({ registry: registryOf(false, {}), categories })).toThrow(
      new ConfigurationError(
        "Port customer.crm: it exports returnsPersonalData and has no implementation in infrastructure/crm/",
      ),
    );
  });
});

const recorder = () => {
  const reads: ReturnedRead[][] = [];
  return {
    reads,
    run: {
      read: async (read: readonly ReturnedRead[]) => {
        reads.push([...read]);
      },
    },
  };
};

describe("bindReturns", () => {
  it("reads what each declared method answered before the caller gets it", async () => {
    const returns = built({
      find: { persons: ({ result }: { result: { ids: string[] } }) => [...result.ids, null] },
      ping: false,
    });
    const { reads, run } = recorder();
    const crm = {
      prefix: "c-",
      find(id: string) {
        return Promise.resolve({ ids: [`${this.prefix}${id}`, `${this.prefix}${id}`, undefined] });
      },
      ping: async () => "pong",
      version: 2,
    };
    const ports = bindReturns(returns, "customer", { crm, other: 1 }, run);
    expect(ports.other).toBe(1);
    const bound = ports.crm as typeof crm;
    expect(bound).toBe(ports.crm);
    expect(bound.find).toBe(bound.find);
    await expect(bound.find("1")).resolves.toEqual({ ids: ["c-1", "c-1", undefined] });
    expect(reads).toEqual([[{ person: "c-1", categories: ["default"] }]]);
    expect(bound.ping).toBe(crm.ping);
    expect(bound.version).toBe(2);
    expect(bound.toString).toBe(crm.toString);
    expect(bindReturns(returns, "other", { crm }, run).crm).toBe(crm);
  });

  it("reads what a port that is a function answered, and passes its other members", async () => {
    const returns = built({
      persons: ({ args: [id] }: { args: [string] }) => id,
      categories: ["contact"],
    });
    const { reads, run } = recorder();
    const lookup = Object.assign(async (id: string) => ({ id }), { close: async () => "closed" });
    const bound = bindReturns(returns, "customer", { crm: lookup }, run).crm as typeof lookup;
    await expect(bound("c-1")).resolves.toEqual({ id: "c-1" });
    expect(reads).toEqual([[{ person: "c-1", categories: ["contact"] }]]);
    await expect(bound.close()).resolves.toBe("closed");
    expect(reads).toHaveLength(1);
    const methods = built({ find: { persons } });
    const called = bindReturns(methods, "customer", { crm: lookup }, run).crm as typeof lookup;
    await expect(called("c-2")).resolves.toEqual({ id: "c-2" });
    expect(reads).toHaveLength(1);
  });

  it("reads whom a failed call's error may quote, then throws the error", async () => {
    const returns = built({
      find: { persons, personsOnError: ({ args: [id] }: { args: [string] }) => id },
      sync: { persons, personsOnError: ({ error }: { error: Error }) => error.message },
      bare: { persons },
    });
    const { reads, run } = recorder();
    const failure = new Error("c-9");
    const crm = {
      find: async (_id: string) => {
        throw failure;
      },
      sync: () => {
        throw failure;
      },
      bare: async () => {
        throw failure;
      },
    };
    const bound = bindReturns(returns, "customer", { crm }, run).crm as typeof crm;
    await expect(bound.find("c-1")).rejects.toBe(failure);
    await expect(bound.sync()).rejects.toBe(failure);
    await expect(bound.bare()).rejects.toBe(failure);
    expect(reads).toEqual([
      [{ person: "c-1", categories: ["default"] }],
      [{ person: "c-9", categories: ["default"] }],
    ]);
  });

  it("refuses an answer it cannot read, and lets a refusal of the run through", async () => {
    const returns = built({
      find: { persons: ({ result }: { result: unknown }) => result },
      sync: { persons },
    });
    const refusal = new Error("restricted");
    const crm = { find: async (value: unknown) => value, sync: () => ({ id: "c-1" }) };
    const bound = bindReturns(returns, "customer", { crm }, recorder().run).crm as typeof crm;
    await expect(bound.find(42)).rejects.toThrow(
      new ConfigurationError(
        "Port customer.crm: method find: persons named 42, which is no person id",
      ),
    );
    await expect(bound.find([""])).rejects.toThrow(
      new ConfigurationError(
        'Port customer.crm: method find: persons named "", which is no person id',
      ),
    );
    expect(() => bound.sync()).toThrow(
      new ConfigurationError(
        "Port customer.crm: method sync answered without a promise, and returnsPersonalData says it returns personal data: make it answer a promise",
      ),
    );
    const refused = bindReturns(
      returns,
      "customer",
      { crm },
      {
        read: async () => {
          throw refusal;
        },
      },
    ).crm as typeof crm;
    await expect(refused.find("c-1")).rejects.toBe(refusal);
  });

  it("leaves a value that is no port as it is, and reads a missing port only where it is used", () => {
    const returns = built({ persons });
    const missing = new ConfigurationError("missing");
    const ports = Object.defineProperty({}, "crm", {
      enumerable: true,
      get: () => {
        throw missing;
      },
    });
    const bound = bindReturns(returns, "customer", ports, recorder().run);
    expect(() => bound.crm).toThrow(missing);
    expect(bindReturns(returns, "customer", { crm: null }, recorder().run).crm).toBeNull();
    expect(bindReturns(returns, "customer", { crm: "text" }, recorder().run).crm).toBe("text");
  });
});
