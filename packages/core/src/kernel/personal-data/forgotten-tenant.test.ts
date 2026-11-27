import { describe, expect, it } from "vitest";
import type {
  ForgetLedgerEntry,
  ReadForgetLedgerArgs,
} from "../../adapter/storage/forget-ledger.ts";
import type { TenantFence } from "../../adapter/storage/tenant-fence.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { TenantForgottenError } from "../../contracts/errors.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { TenantForgottenPayload } from "../../modules/bounda-events.ts";
import { startedBy } from "../shared/causation.ts";
import { createRecordingLogger } from "../test-support.ts";
import { rejecting, settleTenantForgetting } from "./forgotten-tenant.ts";
import {
  FORGET_LEDGER_CURSOR,
  FORGET_LEDGER_PAGE,
  FORGET_LEDGER_REREAD_MS,
} from "./reconciliation.ts";

const AT = "2026-03-01T00:00:00.000Z";
const FORGETTING = { at: AT, eventId: "tenant-forgotten" };

const forgetting = (index: number): ForgetLedgerEntry => ({
  personId: `p-${index}`,
  categories: null,
  eventId: `f-${String(index).padStart(4, "0")}`,
  forgottenAt: "2026-02-01T00:00:00.000Z",
  reason: "requested",
});

const disclosed: ForgetLedgerEntry = {
  personId: "c-1",
  categories: null,
  eventId: "d-1",
  forgottenAt: "2026-02-02T00:00:00.000Z",
  reason: "requested",
  disclosure: {
    port: "customer.mailer",
    recipient: "Mailchimp",
    kind: "processor",
    country: "US",
    transfer: {
      safeguard: "standard-contractual-clauses",
      article: "46(2)(c)",
      regime: "US",
      partialAdequacy: null,
    },
    category: "contact",
  },
};

// A database bound to its tenant, the cursor of its reconciliation at `cursor`.
const opened = async (cursor: number) => {
  const storage = await memory().createStorage();
  await storage.tenancy.bind({ tenant: "acme", store: "s-1", boundAt: AT });
  if (cursor > 0) await storage.checkpointStore.compareAndSet(FORGET_LEDGER_CURSOR, 0, cursor);
  return storage;
};

const settle = async (
  storage: Awaited<ReturnType<typeof opened>>,
  read: (args: ReadForgetLedgerArgs) => Promise<readonly ForgetLedgerEntry[]>,
) => {
  await settleTenantForgetting({
    storage: storage.forgotten(),
    readModels: [],
    tenant: "acme",
    forgetting: FORGETTING,
    ledger: { read, fence: { read: async () => ({ state: "open" }), set: async (fence) => fence } },
    mayBeCopy: true,
    ports: [{ port: "customer.crm", categories: ["contact"] }],
    ids: createSequentialIdGenerator(),
    clock: createFixedClock(new Date(AT)),
    logger: silentLogger,
    concurrencyRetries: 3,
    context: startedBy("c", undefined),
  });
  const [event] = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
  return (event?.payload as TenantForgottenPayload | undefined)?.recipients;
};

describe("settling a tenant's forgetting with a forget ledger", () => {
  it("records again the disclosures the ledger holds past the database's cursor, page after page", async () => {
    const cursor = Date.parse("2026-02-01T12:00:00.000Z");
    const storage = await opened(cursor);
    const first = Array.from({ length: FORGET_LEDGER_PAGE }, (_, index) => forgetting(index));
    const reads: ReadForgetLedgerArgs[] = [];
    const recipients = await settle(storage, async (args) => {
      reads.push(args);
      return reads.length === 1 ? first : [disclosed];
    });
    expect(reads).toEqual([
      {
        after: {
          forgottenAt: new Date(cursor - FORGET_LEDGER_REREAD_MS).toISOString(),
          eventId: "",
        },
        limit: FORGET_LEDGER_PAGE,
      },
      { after: first.at(-1), limit: FORGET_LEDGER_PAGE },
    ]);
    // Told as received, not presumed: the ledger said who received what.
    expect(recipients).toEqual([
      { port: "customer.mailer", categories: ["contact"], retained: [], presumed: false },
    ]);
    expect(
      await storage.recipients.personsOf({ port: "customer.mailer", after: null, limit: 10 }),
    ).toEqual(["c-1"]);
  });

  it("reads the ledger from its first entry for a database that applied none", async () => {
    const storage = await opened(0);
    const reads: ReadForgetLedgerArgs[] = [];
    await settle(storage, async (args) => {
      reads.push(args);
      return [];
    });
    expect(reads).toStrictEqual([{ limit: FORGET_LEDGER_PAGE }]);
  });

  it("rejects, presuming nothing, when the database fails to record a lost disclosure again", async () => {
    const storage = await opened(0);
    const failing = {
      ...storage,
      forgotten: () => ({
        ...storage.forgotten(),
        transact: () => Promise.reject(new Error("the database went away")),
      }),
    } as typeof storage;
    await expect(settle(failing, async () => [disclosed])).rejects.toThrow(
      "the database went away",
    );
    expect(await storage.eventStore.readAll({ afterPosition: 0, limit: 10 })).toEqual([]);
  });

  it("reads nothing of the ledger for a database that holds the forgetting already", async () => {
    const storage = await opened(0);
    let reads = 0;
    const read = async () => {
      reads += 1;
      return [];
    };
    await settle(storage, read);
    await settle(storage, read);
    expect(reads).toBe(1);
  });
});

describe("settling a tenant's forgetting behind its fences", () => {
  it("raises the ledger's fence, then the database's, before it reads anything, and every read model's", async () => {
    const storage = await opened(0);
    const steps: string[] = [];
    const fenceOf = (name: string) => ({
      read: async () => ({ state: "open" }) as const,
      set: async (fence: TenantFence) => {
        steps.push(`${name} ${fence.state}`);
        return fence;
      },
    });
    const forgotten = storage.forgotten();
    const readModel = (name: string, personal: boolean) => ({
      name,
      personal,
      storage: {
        fence: fenceOf(name),
        transact: async <T>(args: {
          readonly forgotten?: boolean;
          readonly subscriber: string;
        }) => {
          steps.push(`${name} rows deleted ${String(args.forgotten)} ${args.subscriber}`);
          return { acquired: true, value: undefined as T } as const;
        },
      },
    });
    await settleTenantForgetting({
      storage: {
        ...forgotten,
        fence: {
          ...forgotten.fence,
          set: async (fence) => {
            steps.push(`storage ${fence.state}`);
            return forgotten.fence.set(fence);
          },
        },
        tenancy: {
          ...forgotten.tenancy,
          forget: async (at) => {
            steps.push("binding");
            await forgotten.tenancy.forget(at);
          },
        },
      },
      readModels: [readModel("customers", true), readModel("totals", false)] as never,
      tenant: "acme",
      forgetting: FORGETTING,
      ledger: {
        read: async () => {
          steps.push("ledger read");
          return [];
        },
        fence: fenceOf("ledger"),
      },
      mayBeCopy: false,
      ports: [],
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(new Date(AT)),
      logger: silentLogger,
      concurrencyRetries: 3,
      context: startedBy("c", undefined),
    });
    expect(steps).toEqual([
      "ledger forgotten",
      "storage forgotten",
      "binding",
      "ledger read",
      "customers forgotten",
      "customers rows deleted true projection:customers",
      "totals forgotten",
    ]);
    expect(await storage.fence.read()).toEqual({
      state: "forgotten",
      tenant: "acme",
      since: FORGETTING.at,
    });
  });

  it("logs a ledger that does not take its fence, and settles the rest", async () => {
    const storage = await opened(0);
    const { logger, entries } = createRecordingLogger();
    await settleTenantForgetting({
      storage: storage.forgotten(),
      readModels: [],
      tenant: "acme",
      forgetting: FORGETTING,
      ledger: {
        read: async () => [],
        fence: {
          read: async () => ({ state: "open" }),
          set: async () => {
            throw new Error("ledger down");
          },
        },
      },
      mayBeCopy: false,
      ports: [],
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(new Date(AT)),
      logger,
      concurrencyRetries: 3,
      context: startedBy("c", undefined),
    });
    expect(entries.map(({ level, message, fields }) => [level, message, fields?.tenant])).toEqual([
      [
        "error",
        "the forget ledger's fence could not be raised for the tenant's forgetting",
        "acme",
      ],
    ]);
    expect(await storage.eventStore.lastPosition()).toBe(1);
  });
});

describe("rejecting", () => {
  it("owns every name, at any depth, each of which rejects with the forgetting, and is no promise", async () => {
    const forgetting = new TenantForgottenError("acme", "2026-01-01T00:00:00.000Z");
    const facade = rejecting(() => forgetting) as Readonly<Record<string, unknown>>;
    expect(Object.hasOwn(facade, "placeOrder")).toBe(true);
    const placeOrder = Reflect.get(facade, "placeOrder") as () => Promise<unknown>;
    await expect(placeOrder()).rejects.toBe(forgetting);
    const deep = Reflect.get(Reflect.get(facade, "deadLetters") as object, "list");
    await expect((deep as () => Promise<unknown>)()).rejects.toBe(forgetting);
    expect(Object.getOwnPropertyDescriptor(facade, "placeOrder")).toEqual({
      value: facade,
      writable: false,
      enumerable: false,
      configurable: true,
    });
    // Its own, as the function it stands on has them.
    expect(Object.getOwnPropertyDescriptor(facade, "length")).toMatchObject({ value: 0 });
    expect(Object.hasOwn(facade, "then")).toBe(false);
    expect(Reflect.get(facade, "then")).toBeUndefined();
    expect(Object.hasOwn(facade, Symbol.iterator)).toBe(false);
    await expect(Promise.resolve(facade)).resolves.toBe(facade);
  });
});
