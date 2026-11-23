import { describe, expect, it } from "vitest";
import type {
  ForgetLedgerEntry,
  ReadForgetLedgerArgs,
} from "../../adapter/storage/forget-ledger.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { TenantForgottenPayload } from "../../modules/bounda-events.ts";
import { startedBy } from "../shared/causation.ts";
import { settleTenantForgetting } from "./forgotten-tenant.ts";
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
    safeguard: "standard-contractual-clauses",
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
    storage,
    readModels: [],
    tenant: "acme",
    forgetting: FORGETTING,
    ledger: { read },
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
