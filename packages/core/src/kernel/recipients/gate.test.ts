import { beforeEach, describe, expect, it } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import type { Disclosure } from "../../adapter/storage/recipient-store.ts";
import { testMetadata } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ConcurrencyError, ProcessingRestrictedError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import type { PersonalDataAccess } from "../../modules/audit.ts";
import type { RecordAccess } from "../personal-data/access.ts";
import { fenceOf, stampFence } from "../personal-data/fences.ts";
import type { ForgetIntentions } from "../personal-data/intention.ts";
import type { RecipientRuntime, RecipientsRuntime } from "./build.ts";
import {
  createDisclosures,
  type DisclosingRun,
  type OpenedData,
  openedOf,
  PersonalDataChangedError,
} from "./gate.ts";

const NOW = new Date("2026-03-01T00:00:00.000Z");

const recipient = (overrides: Partial<RecipientRuntime> = {}): RecipientRuntime => ({
  port: "customer.mailer",
  owner: "customer",
  name: "mailer",
  recipient: "Mailchimp",
  kind: "processor",
  country: "US",
  safeguard: "standard-contractual-clauses",
  categories: ["contact", "profile"],
  formerly: [],
  handlers: {} as RecipientRuntime["handlers"],
  implementation: () => undefined,
  ...overrides,
});

const runtimeOf = (...all: RecipientRuntime[]): RecipientsRuntime => ({
  all,
  byPort: Object.fromEntries(all.map((each) => [each.port, each])),
  byOwner: Object.fromEntries(all.map((each) => [each.owner, { [each.name]: each }])),
});

let storage: Storage;
let accesses: PersonalDataAccess[];
let ledgered: (readonly Disclosure[])[];

const recordAccess: RecordAccess = async (args) => {
  accesses.push({ ...args, persons: [...args.persons] } as unknown as PersonalDataAccess);
};

const intentions = {
  disclose: async (rows: readonly Disclosure[]) => {
    ledgered.push(rows);
  },
} as unknown as ForgetIntentions;

const disclosuresOf = (runtime = runtimeOf(recipient())) =>
  createDisclosures({
    recipients: runtime,
    storage,
    intentions,
    recordAccess,
    clock: createFixedClock(NOW),
  });

const run = (
  opened: readonly OpenedData[],
  overrides: Partial<DisclosingRun> = {},
): DisclosingRun => ({
  opened: () => opened,
  basis: undefined,
  handler: "customer.welcome",
  actor: "ops-1",
  ...overrides,
});

const key = async (person: string, category: string, fingerprint: string): Promise<void> => {
  await storage.personalKeys.add(person, category, { key: "k", fingerprint, kid: null });
};

const boundaEvent = async (person: string): Promise<number> =>
  storage.transact(async (transaction) => {
    const { version } = await transaction.eventStore.load({
      aggregateType: "bounda",
      aggregateId: person,
    });
    const { events } = await transaction.eventStore.append({
      aggregateType: "bounda",
      aggregateId: person,
      expectedVersion: version,
      events: [
        {
          id: `e-${person}-${version + 1}`,
          aggregateType: "bounda",
          aggregateId: person,
          version: version + 1,
          type: "ProcessingRestricted",
          payload: { personId: person },
          timestamp: NOW.toISOString(),
          metadata: testMetadata,
          person,
        },
      ],
    });
    return events[0]?.position ?? 0;
  });

interface Mailer {
  send(to: string): Promise<string>;
  readonly from: string;
}

const mailer = (sent: string[]): Mailer => ({
  from: "hello@example.com",
  send: async function (this: Mailer, to: string) {
    sent.push(to);
    return this.from;
  },
});

beforeEach(async () => {
  storage = await memory().createStorage();
  accesses = [];
  ledgered = [];
});

describe("PersonalDataChangedError", () => {
  it("is a conflict on the person's own stream, naming them", () => {
    const error = new PersonalDataChangedError("c-1", 4, 2);
    expect(error).toBeInstanceOf(ConcurrencyError);
    expect(error).toMatchObject({
      code: "CONCURRENCY_CONFLICT",
      streamId: "bounda:c-1",
      expectedVersion: 4,
      actualVersion: 2,
      personId: "c-1",
      message: "Person c-1's data changed since it was read",
    });
  });
});

describe("openedOf", () => {
  it("takes what a unit read, with whether its key was kept and the fence it was read at", () => {
    const fenced = { person: "c-1", fingerprint: "f-1" };
    const kept = { person: "c-2", fingerprint: "f-2", retained: true as const };
    stampFence([fenced], 7);
    expect(openedOf([fenced, kept])).toEqual([
      { person: "c-1", fingerprint: "f-1", fence: 7 },
      { person: "c-2", fingerprint: "f-2", retained: true, fence: undefined },
    ]);
    expect(fenceOf(kept)).toBeUndefined();
  });
});

describe("createDisclosures", () => {
  it("leaves the ports of an owner without recipients, and every other port, as they are", () => {
    const disclosures = disclosuresOf();
    const ports = { mailer: {} };
    expect(disclosures.tells("order")).toBe(false);
    expect(disclosures.tells("customer")).toBe(true);
    expect(disclosures.bind("order", ports, run([]))).toBe(ports);
    let reads = 0;
    const lazy = Object.defineProperty({}, "sms", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "sms port";
      },
    });
    const bound = disclosures.bind("customer", lazy, run([]));
    expect(reads).toBe(0);
    expect(Reflect.get(bound, "sms")).toBe("sms port");
    expect(reads).toBe(1);
  });

  it("builds a recipient's port once, when first read, and hands a value that is no port as it is", async () => {
    const disclosures = disclosuresOf();
    let reads = 0;
    const sent: string[] = [];
    const ports = Object.defineProperty({}, "mailer", {
      enumerable: true,
      get: () => {
        reads += 1;
        return mailer(sent);
      },
    });
    const bound = disclosures.bind("customer", ports, run([])) as { mailer: Mailer };
    expect(reads).toBe(0);
    expect(bound.mailer).toBe(bound.mailer);
    expect(reads).toBe(1);
    expect(bound.mailer.send).toBe(bound.mailer.send);
    expect(bound.mailer.from).toBe("hello@example.com");
    expect(await bound.mailer.send("ana")).toBe("hello@example.com");
    expect(sent).toEqual(["ana"]);
    for (const value of [undefined, null, 7]) {
      expect(Reflect.get(disclosures.bind("customer", { mailer: value }, run([])), "mailer")).toBe(
        value,
      );
    }
  });

  it("records what the run read of the recipient's categories, each call, and nothing else", async () => {
    await key("c-1", "contact", "f-contact");
    await key("c-1", "invoices", "f-invoices");
    await key("c-2", "profile", "f-profile");
    const sent: string[] = [];
    const disclosures = disclosuresOf();
    const bound = disclosures.bind(
      "customer",
      { mailer: mailer(sent) },
      run([
        { person: "c-1", fingerprint: "f-contact", fence: undefined },
        { person: "c-1", fingerprint: "f-invoices", fence: undefined },
        { person: "c-2", fingerprint: "f-profile", fence: undefined },
        { person: "c-3", fingerprint: null, fence: undefined },
        { person: "c-4", fingerprint: null, category: "contact", fence: undefined },
        { person: "c-5", fingerprint: null, category: "invoices", fence: undefined },
      ]),
    ) as { mailer: Mailer };
    await bound.mailer.send("ana");
    expect(
      (
        await Promise.all(
          ["c-1", "c-2", "c-3", "c-4", "c-5"].map((person) =>
            storage.recipients.disclosures(person),
          ),
        )
      )
        .flat()
        .map(({ person, category, firstAt }) => [person, category, firstAt]),
    ).toEqual([
      ["c-1", "contact", NOW.toISOString()],
      ["c-2", "profile", NOW.toISOString()],
      ["c-4", "contact", NOW.toISOString()],
    ]);
    expect(ledgered.map((rows) => rows.map(({ person }) => person))).toEqual([
      ["c-1", "c-2", "c-4"],
    ]);
    expect(accesses).toEqual([
      {
        operation: "disclosure",
        detail: {
          recipient: "customer.mailer",
          handler: "customer.welcome",
          categories: ["contact", "profile"],
        },
        actor: "ops-1",
        persons: ["c-1", "c-2", "c-4"],
        outcome: "ok",
        restricted: null,
      },
    ]);
    await bound.mailer.send("ana");
    expect(ledgered).toHaveLength(1);
    expect(accesses).toHaveLength(2);
    expect(sent).toEqual(["ana", "ana"]);
  });

  it("calls a port that is a function itself after recording, and records nothing for a run that read nothing of it", async () => {
    await key("c-1", "contact", "f-contact");
    const called: unknown[] = [];
    const port = async (...args: unknown[]) => {
      called.push(args);
      return "sent";
    };
    const disclosures = disclosuresOf();
    const bound = disclosures.bind(
      "customer",
      { mailer: port },
      run([{ person: "c-1", fingerprint: "f-contact", fence: undefined }]),
    ) as { mailer: typeof port };
    expect(await bound.mailer("ana", 2)).toBe("sent");
    expect(called).toEqual([["ana", 2]]);
    expect(await storage.recipients.disclosures("c-1")).toHaveLength(1);
    const idle = disclosures.bind("customer", { mailer: port }, run([])) as { mailer: typeof port };
    await idle.mailer("bo");
    expect(accesses).toHaveLength(1);
  });

  it("refuses, before the port, data whose key went since it was read", async () => {
    const sent: string[] = [];
    const bound = disclosuresOf().bind(
      "customer",
      { mailer: mailer(sent) },
      run([{ person: "c-1", fingerprint: "f-gone", fence: 3 }]),
    ) as { mailer: Mailer };
    await expect(bound.mailer.send("ana")).rejects.toMatchObject({
      streamId: "bounda:c-1",
      expectedVersion: 3,
    });
    const unfenced = disclosuresOf().bind(
      "customer",
      { mailer: mailer(sent) },
      run([{ person: "c-1", fingerprint: "f-gone", fence: undefined }]),
    ) as { mailer: Mailer };
    await expect(unfenced.mailer.send("ana")).rejects.toMatchObject({ expectedVersion: 0 });
    expect(sent).toEqual([]);
  });

  it("refuses data of a person whose stream moved past the earliest read of them", async () => {
    await key("c-1", "contact", "f-contact");
    await key("c-2", "contact", "f-c2");
    const early = await boundaEvent("c-1");
    const later = await boundaEvent("c-1");
    await boundaEvent("c-2");
    const sent: string[] = [];
    const fresh = disclosuresOf().bind(
      "customer",
      { mailer: mailer(sent) },
      run([
        { person: "c-1", fingerprint: "f-contact", fence: later },
        { person: "c-1", fingerprint: "f-contact", fence: later + 5 },
        { person: "c-2", fingerprint: "f-c2", fence: undefined },
      ]),
    ) as { mailer: Mailer };
    await fresh.mailer.send("ana");
    expect(sent).toEqual(["ana"]);
    const stale = disclosuresOf().bind(
      "customer",
      { mailer: mailer(sent) },
      run([
        { person: "c-1", fingerprint: "f-contact", fence: later + 5 },
        { person: "c-1", fingerprint: "f-contact", fence: early },
      ]),
    ) as { mailer: Mailer };
    await expect(stale.mailer.send("ana")).rejects.toEqual(
      new PersonalDataChangedError("c-1", early, 2),
    );
    expect(sent).toEqual(["ana"]);
  });

  it("refuses restricted data the run names no basis for, and records the basis that lets it through", async () => {
    await key("c-1", "contact", "f-contact");
    await storage.persons.restrict("c-1", { ground: "legal-claims", categories: null, since: NOW });
    const sent: string[] = [];
    const opened = [{ person: "c-1", fingerprint: "f-contact", fence: undefined }];
    const refused = disclosuresOf().bind("customer", { mailer: mailer(sent) }, run(opened)) as {
      mailer: Mailer;
    };
    await expect(refused.mailer.send("ana")).rejects.toBeInstanceOf(ProcessingRestrictedError);
    expect(await storage.recipients.disclosures("c-1")).toEqual([]);
    const allowed = disclosuresOf().bind(
      "customer",
      { mailer: mailer(sent) },
      run(opened, { basis: "legal-claims" }),
    ) as { mailer: Mailer };
    await allowed.mailer.send("ana");
    expect(accesses.at(-1)).toMatchObject({
      restricted: { basis: "legal-claims", persons: ["c-1"] },
    });
    expect(sent).toEqual(["ana"]);
  });

  it("lets a run on a basis through what a forgetting kept, and names nobody restricted without a restriction", async () => {
    await key("c-1", "contact", "f-contact");
    await storage.personalKeys.retain("c-1", "f-contact", {
      since: NOW.toISOString(),
      lastActiveAt: NOW.toISOString(),
    });
    const sent: string[] = [];
    const opened = [{ person: "c-1", fingerprint: "f-contact", retained: true, fence: undefined }];
    const kept = disclosuresOf().bind(
      "customer",
      { mailer: mailer(sent) },
      run(opened, { basis: "legal-obligation" }),
    ) as { mailer: Mailer };
    await kept.mailer.send("ana");
    expect(accesses.at(-1)).toMatchObject({
      restricted: { basis: "legal-obligation", persons: ["c-1"] },
    });
    const plain = disclosuresOf().bind(
      "customer",
      { mailer: mailer(sent) },
      run([{ person: "c-1", fingerprint: "f-contact", fence: undefined }], { basis: "consent" }),
    ) as { mailer: Mailer };
    await plain.mailer.send("bo");
    expect(accesses.at(-1)?.restricted).toBeNull();
  });
});
