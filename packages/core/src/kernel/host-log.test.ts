import { describe, expect, it } from "vitest";
import { createFixedClock } from "../contracts/clock.ts";
import {
  ConfigurationError,
  NotFoundError,
  TenantForgottenError,
  TenantFrozenError,
} from "../contracts/errors.ts";
import type { OnHostRejectionArgs } from "../modules/audit.ts";
import {
  HOST_REJECTED,
  hostLogOf,
  type RecordHostRejectionArgs,
  recordedRejections,
} from "./host-log.ts";
import { createRecordingLogger } from "./test-support.ts";

const refusal: RecordHostRejectionArgs = {
  tenant: "acme",
  reason: "unknown-query",
  target: "queries.nothing",
  actor: "user-1",
};

describe("hostLogOf", () => {
  it("hands each record to app/audit.ts with the host's env and logger, at the clock's time", async () => {
    const received: OnHostRejectionArgs[] = [];
    const { logger, entries } = createRecordingLogger();
    const clock = createFixedClock(new Date("2026-03-01T10:00:00Z"));
    const env = { AUDIT_URL: "https://audit.example" };
    await hostLogOf({
      registry: {
        audit: {
          onPersonalDataAccess: () => {},
          onHostRejection: (args) => {
            received.push(args);
          },
        },
      },
      env,
      logger,
      clock,
    })(refusal);
    expect(received).toEqual([
      { rejection: { at: "2026-03-01T10:00:00.000Z", ...refusal }, env, logger },
    ]);
    expect(entries).toEqual([]);
  });

  it("goes to the logger at info without app/audit.ts, on the wall clock by default", async () => {
    const { logger, entries } = createRecordingLogger();
    const before = Date.now();
    for (const registry of [undefined, {}]) {
      await hostLogOf({ registry, env: {}, logger })({ ...refusal, tenant: null, actor: null });
    }
    expect(entries).toEqual([
      {
        level: "info",
        message: HOST_REJECTED,
        fields: { at: expect.any(String), ...refusal, tenant: null, actor: null },
      },
      {
        level: "info",
        message: HOST_REJECTED,
        fields: { at: expect.any(String), ...refusal, tenant: null, actor: null },
      },
    ]);
    const at = Date.parse(String(entries[0]?.fields?.at));
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
    expect(HOST_REJECTED).toBe("request refused");
  });

  it("rejects with what app/audit.ts throws", async () => {
    const record = hostLogOf({
      registry: {
        audit: {
          onPersonalDataAccess: () => {},
          onHostRejection: async () => {
            throw new Error("audit sink down");
          },
        },
      },
      env: {},
      logger: createRecordingLogger().logger,
    });
    await expect(record(refusal)).rejects.toThrow("audit sink down");
  });

  it("refuses an app/audit.ts that does not export onHostRejection", () => {
    for (const onHostRejection of [undefined, "a sink"]) {
      expect(() =>
        hostLogOf({
          registry: {
            audit: { onPersonalDataAccess: () => {}, onHostRejection } as never,
          },
          env: {},
          logger: createRecordingLogger().logger,
        }),
      ).toThrow(
        new ConfigurationError(
          "app/audit.ts does not export onHostRejection, the function the host log goes to",
        ),
      );
    }
  });
});

describe("recordedRejections", () => {
  const forgotten = new TenantForgottenError("acme", "2026-01-01T00:00:00.000Z");
  const frozen = new TenantFrozenError("acme", "2026-01-01T00:00:00.000Z");

  const clientOf = (error: unknown) => {
    const fail = async (): Promise<never> => {
      throw error;
    };
    const config = { runtime: {} };
    const other = { name: "other" };
    return {
      config,
      other,
      commands: { placeOrder: fail },
      deadLetters: { list: fail, nothing: null },
      exportPersonalData: fail,
      count: () => 1,
      as: () => other,
      [Symbol.for("bounda.test")]: fail,
    };
  };

  const watched = (error: unknown) => {
    const records: RecordHostRejectionArgs[] = [];
    const client = recordedRejections({
      client: clientOf(error),
      record: async (args) => {
        records.push(args);
      },
      tenant: "acme",
      actor: "user-1",
    });
    return { client, records };
  };

  it("records a call refused for its tenant's forgetting or freeze, at any depth, and rejects as it did", async () => {
    for (const [error, reason] of [
      [forgotten, "tenant-forgotten"],
      [frozen, "tenant-frozen"],
    ] as const) {
      const { client, records } = watched(error);
      await expect(client.commands.placeOrder()).rejects.toBe(error);
      await expect(client.deadLetters.list()).rejects.toBe(error);
      await expect(client.exportPersonalData()).rejects.toBe(error);
      expect(records).toEqual([
        { tenant: "acme", reason, target: "commands.placeOrder", actor: "user-1" },
        { tenant: "acme", reason, target: "deadLetters.list", actor: "user-1" },
        { tenant: "acme", reason, target: "exportPersonalData", actor: "user-1" },
      ]);
    }
  });

  it("names no actor for a client that acts as nobody", async () => {
    const records: RecordHostRejectionArgs[] = [];
    const client = recordedRejections({
      client: clientOf(forgotten),
      record: async (args) => {
        records.push(args);
      },
      tenant: "acme",
      actor: undefined,
    });
    await expect(client.exportPersonalData()).rejects.toBe(forgotten);
    expect(records).toEqual([
      { tenant: "acme", reason: "tenant-forgotten", target: "exportPersonalData", actor: null },
    ]);
  });

  it("records nothing of any other rejection, of what does not reject, or of what it hands out as it is", async () => {
    const missing = new NotFoundError("no such order");
    const { client, records } = watched(missing);
    await expect(client.commands.placeOrder()).rejects.toBe(missing);
    expect(client.count()).toBe(1);
    const plain = clientOf(missing);
    const again = recordedRejections({
      client: plain,
      record: async () => {},
      tenant: "acme",
      actor: undefined,
    });
    expect(again.config).toBe(plain.config);
    expect(again.commands).toBe(again.commands);
    expect(again.commands.placeOrder).toBe(again.commands.placeOrder);
    expect(again.exportPersonalData).toBe(again.exportPersonalData);
    expect(again.other).toBe(plain.other);
    expect(again.as()).toBe(plain.other);
    expect(again.deadLetters.nothing).toBeNull();
    expect(again[Symbol.for("bounda.test")]).toBe(plain[Symbol.for("bounda.test")]);
    expect(Reflect.get(again.commands, Symbol.iterator)).toBeUndefined();
    expect(records).toEqual([]);
  });

  it("hands out a frozen facade's members as they are, which a proxy must", async () => {
    const records: RecordHostRejectionArgs[] = [];
    const fail = async (): Promise<never> => {
      throw forgotten;
    };
    const commands = Object.freeze({ placeOrder: fail });
    const client = recordedRejections({
      client: { commands },
      record: async (args) => {
        records.push(args);
      },
      tenant: "acme",
      actor: undefined,
    });
    expect(client.commands.placeOrder).toBe(fail);
    await expect(client.commands.placeOrder()).rejects.toBe(forgotten);
    expect(records).toEqual([]);
  });

  it("rejects with what the record throws in place of the refusal", async () => {
    const client = recordedRejections({
      client: clientOf(forgotten),
      record: async () => {
        throw new Error("audit sink down");
      },
      tenant: "acme",
      actor: undefined,
    });
    await expect(client.commands.placeOrder()).rejects.toThrow("audit sink down");
  });
});
