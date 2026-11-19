import type { KeyedPerson, PersonalKeyStore } from "../../adapter/storage/personal-key-store.ts";
import { type Disclosure, disclosureKey } from "../../adapter/storage/recipient-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ConcurrencyError } from "../../contracts/errors.ts";
import { BOUNDA_AGGREGATE } from "../../modules/bounda-events.ts";
import type { RestrictionBasis } from "../../modules/personal-data.ts";
import type { AppStorage } from "../events/app-event-store.ts";
import type { RecordAccess } from "../personal-data/access.ts";
import { fenceOf } from "../personal-data/fences.ts";
import type { ForgetIntentions } from "../personal-data/intention.ts";
import { refuseRestrictedRead } from "../personal-data/refusal.ts";
import type { RecipientRuntime, RecipientsRuntime } from "./build.ts";

/**
 * Thrown when the person whose data was read had their stream move since: a forgetting, a
 * restriction, a lift or a redaction the read may not reflect. By a call to a port that tells a
 * recipient, before anything was handed to it, and by an export, once it has read everything.
 * Either is tried again and reads the data as it is now.
 */
export class PersonalDataChangedError extends ConcurrencyError {
  readonly personId: string;

  constructor(person: string, fence: number, actualVersion: number) {
    super({ streamId: `${BOUNDA_AGGREGATE}:${person}`, expectedVersion: fence, actualVersion });
    this.message = `Person ${person}'s data changed since it was read`;
    this.personId = person;
  }
}

/**
 * Personal data a run opened: of a person, under a key whose category the store tells, or of a
 * category a read model's field says, and the head of the stream before it was read.
 */
export interface OpenedData {
  readonly person: string;
  readonly fingerprint: string | null;
  readonly category?: string;
  /**
   * Read under a key a forgetting kept under an erasure exemption.
   */
  readonly retained?: boolean;
  readonly fence: number | undefined;
}

/**
 * What a run discloses through its recipients' ports: what it read so far, the basis it processes
 * restricted data on, and who and what it is, for the access log.
 */
export interface DisclosingRun {
  readonly opened: () => readonly OpenedData[];
  readonly basis: RestrictionBasis | undefined;
  readonly handler: string;
  readonly actor: string | undefined;
}

export interface OpenedOfFunction {
  (persons: readonly KeyedPerson[]): readonly OpenedData[];
}

/**
 * What a unit of work read, as the gate takes it.
 */
export const openedOf: OpenedOfFunction = (persons) =>
  persons.map((held) => ({
    person: held.person,
    fingerprint: held.fingerprint,
    ...(held.retained === true ? { retained: true } : {}),
    fence: fenceOf(held),
  }));

export interface Disclosures {
  /**
   * Whether a port of the owner tells a recipient.
   */
  tells(owner: string): boolean;
  /**
   * The owner's ports with every port that tells a recipient wrapped: before each of its methods
   * runs, what the run read of the categories its recipient receives is recorded as disclosed, in
   * one transaction that refuses it when a person's stream moved past what was read, or the
   * person is restricted and the run names no basis that opens it. Reading a port stays lazy, as
   * a test app's missing port throws only where it is used.
   */
  bind(
    owner: string,
    ports: Readonly<Record<string, unknown>>,
    run: DisclosingRun,
  ): Readonly<Record<string, unknown>>;
}

export interface CreateDisclosuresArgs {
  readonly recipients: RecipientsRuntime;
  readonly storage: Pick<AppStorage, "transact" | "personalKeys" | "recipients">;
  readonly intentions: ForgetIntentions;
  readonly recordAccess: RecordAccess;
  readonly clock: Clock;
}

export interface CreateDisclosuresFunction {
  (args: CreateDisclosuresArgs): Disclosures;
}

const disclosureOf = (
  recipient: RecipientRuntime,
  person: string,
  category: string,
): Disclosure => ({
  person,
  port: recipient.port,
  recipient: recipient.recipient,
  kind: recipient.kind,
  country: recipient.country,
  safeguard: recipient.safeguard,
  category,
});

export const createDisclosures: CreateDisclosuresFunction = ({
  recipients,
  storage,
  intentions,
  recordAccess,
  clock,
}) => {
  // `undefined` when the key the data was read under is gone: the person was forgotten since.
  const categoryOf = async (
    keys: Pick<PersonalKeyStore, "find">,
    known: Map<string, string | undefined>,
    { person, fingerprint, category }: OpenedData,
  ): Promise<string | null | undefined> => {
    if (category !== undefined) return category;
    if (fingerprint === null) return null;
    const id = JSON.stringify([person, fingerprint]);
    if (!known.has(id)) known.set(id, (await keys.find(person, fingerprint))?.category);
    return known.get(id);
  };

  // Every call checks again, in a transaction of its own, that nothing changed of the persons
  // since the run read them, and records the disclosure: two calls of one run may straddle a
  // forgetting.
  const disclose = async (
    recipient: RecipientRuntime,
    run: DisclosingRun,
    known: Map<string, string | undefined>,
  ): Promise<void> => {
    const fences = new Map<string, number>();
    const rows = new Map<string, Disclosure>();
    const readUnder: KeyedPerson[] = [];
    for (const data of run.opened()) {
      const category = await categoryOf(storage.personalKeys, known, data);
      if (category === undefined) {
        throw new PersonalDataChangedError(data.person, data.fence ?? 0, 0);
      }
      if (category === null || !recipient.categories.includes(category)) continue;
      if (data.fence !== undefined) {
        fences.set(data.person, Math.min(fences.get(data.person) ?? data.fence, data.fence));
      }
      if (data.fingerprint !== null) {
        readUnder.push({
          person: data.person,
          fingerprint: data.fingerprint,
          ...(data.retained === true ? { retained: true } : {}),
        });
      }
      const disclosure = disclosureOf(recipient, data.person, category);
      rows.set(JSON.stringify([disclosure.person, disclosure.category]), disclosure);
    }
    if (rows.size === 0) return;
    const disclosed = [...rows.values()];
    const persons = [...new Set(disclosed.map(({ person }) => person))];
    const at = clock.now().toISOString();
    // What the store has not seen goes to the forget ledger before it is recorded, so a restore
    // that loses it still tells the recipient, and a call refused below leaves at most a
    // disclosure that never happened, which only tells the recipient once too often.
    const stored = new Set(
      (await Promise.all(persons.map((person) => storage.recipients.disclosures(person))))
        .flat()
        .map(disclosureKey),
    );
    const fresh = disclosed.filter((row) => !stored.has(disclosureKey(row)));
    if (fresh.length > 0) await intentions.disclose(fresh, at);
    const letThrough = await storage.transact(async (transaction) => {
      for (const person of persons) {
        const fence = fences.get(person);
        if (fence === undefined) continue;
        const { events, version } = await transaction.eventStore.load({
          aggregateType: BOUNDA_AGGREGATE,
          aggregateId: person,
        });
        if (events.some((event) => event.position > fence)) {
          throw new PersonalDataChangedError(person, fence, version);
        }
      }
      const through = await refuseRestrictedRead({
        persons: transaction.persons,
        keys: transaction.personalKeys,
        opened: readUnder,
        touches: [],
        basis: run.basis,
      });
      await transaction.recipients.disclose(disclosed, at);
      return through;
    });
    await recordAccess({
      operation: "disclosure",
      detail: {
        recipient: recipient.port,
        handler: run.handler,
        categories: [...new Set(disclosed.map(({ category }) => category))].sort(),
      },
      actor: run.actor,
      persons,
      outcome: "ok",
      error: undefined,
      restricted:
        run.basis === undefined || letThrough.length === 0
          ? null
          : { basis: run.basis, persons: letThrough },
    });
  };

  const wrapped = (
    recipient: RecipientRuntime,
    implementation: unknown,
    run: DisclosingRun,
    known: Map<string, string | undefined>,
  ): unknown => {
    if (
      (typeof implementation !== "object" && typeof implementation !== "function") ||
      implementation === null
    ) {
      return implementation;
    }
    const methods = new Map<PropertyKey, unknown>();
    // A port may be a function itself, called as it is, or an object of methods, each of them
    // gated; a property that is no function is read as it is.
    return new Proxy(implementation, {
      apply: async (target, self, args: unknown[]) => {
        await disclose(recipient, run, known);
        return Reflect.apply(target as (...args: unknown[]) => unknown, self, args);
      },
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (!methods.has(property)) {
          methods.set(property, async (...args: unknown[]) => {
            await disclose(recipient, run, known);
            return (value as (...args: unknown[]) => unknown).apply(target, args);
          });
        }
        return methods.get(property);
      },
    });
  };

  return {
    tells: (owner) => recipients.byOwner[owner] !== undefined,
    bind: (owner, ports, run) => {
      const own = recipients.byOwner[owner];
      if (own === undefined) return ports;
      const known = new Map<string, string | undefined>();
      const bound: Record<string, unknown> = {};
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(ports))) {
        const recipient = own[name];
        if (recipient === undefined) {
          Object.defineProperty(bound, name, descriptor);
          continue;
        }
        let built: { readonly port: unknown } | undefined;
        Object.defineProperty(bound, name, {
          enumerable: true,
          get: () => {
            built ??= {
              port: wrapped(recipient, Reflect.get(ports, name), run, known),
            };
            return built.port;
          },
        });
      }
      return bound;
    },
  };
};
