import { codePointOrder } from "../../adapter/sql/order.ts";
import type { StoredDeadLetter } from "../../adapter/storage/dead-letter-store.ts";
import type { ForgetLedger, ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import type { StoredPerson } from "../../adapter/storage/person-store.ts";
import {
  DEFAULT_PERSONAL_CATEGORY,
  type KeyedPerson,
} from "../../adapter/storage/personal-key-store.ts";
import type { StoredSubscriberFailure } from "../../adapter/storage/subscriber-failure-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ConcurrencyError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { type ExportOutcome, MAX_ACCESS_PERSONS } from "../../modules/audit.ts";
import type { PersonRecipient } from "../../modules/recipient.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { AppStorage } from "../events/app-event-store.ts";
import type { ProcessesRuntime } from "../process/build-processes.ts";
import { processOfStream } from "../process/lifecycle.ts";
import { projectionSubscriberName, type SealingSource } from "../projection/runner.ts";
import type { ReadModelsRuntime } from "../read-model/build-read-models.ts";
import { openRow } from "../read-model/sealed-rows.ts";
import { createSealingKeyRing } from "../read-model/sealing-keys.ts";
import type { RecipientsRuntime } from "../recipients/build.ts";
import { recipientsOfPage } from "../recipients/listing.ts";
import { isRecord } from "../shared/merge-fields.ts";
import { openAnswer } from "./answers.ts";
import type { PersonalCategories } from "./categories.ts";
import { openCommandPayload, sealedKeys } from "./commands.ts";
import { openTextWith, textPersons } from "./errors.ts";
import { openedUnder, redactedIn } from "./event-store.ts";
import type { ExportedCategories, ExportedRestricted, ExportedTransfer } from "./export.ts";
import { personalDataInformation } from "./information.ts";
import { FORGET_LEDGER_SUBSCRIBER } from "./ledger-outbox.ts";
import { fieldCategory, type PersonalMarks } from "./marks.ts";
import { lifecycleStateOf } from "./process-state.ts";
import { processingRestrictionsOf } from "./restriction.ts";
import {
  countTenantRecord,
  NO_TENANT_EXPORT_RECORDS,
  TENANT_EXPORT_FORMAT,
  TENANT_EXPORT_VERSION,
  type TenantExportCategory,
  type TenantExportCounts,
  type TenantExportHeader,
  type TenantExportPart,
  type TenantExportRecord,
} from "./tenant-export.ts";
import { tallyRecipients } from "./tenant-recipients.ts";

/**
 * Thrown by a tenant export, once it has read everything, when the stream moved past the head its
 * header names: what was written meanwhile may be in some parts and missing from others.
 */
export class TenantDataChangedError extends ConcurrencyError {
  readonly tenant: string;

  constructor(tenant: string, position: number, actual: number) {
    super({ streamId: "$all", expectedVersion: position, actualVersion: actual });
    this.message = `Tenant ${tenant}'s data changed while it was exported`;
    this.tenant = tenant;
  }
}

export interface StreamTenantExportArgs {
  /**
   * The app's storage, whose event store opens the fields and upcasts the payloads.
   */
  readonly storage: AppStorage;
  readonly aggregates: AggregatesRuntime;
  /**
   * Whose state schemas mark the fields their lifecycle events hold.
   */
  readonly processes: Pick<ProcessesRuntime, "byName">;
  readonly readModels: ReadModelsRuntime;
  /**
   * What the read models' values are opened with.
   */
  readonly sealing: SealingSource;
  readonly clock: Clock;
  /**
   * How many records each read takes: the export holds no more than one page of them at a time.
   */
  readonly batchSize: number;
  readonly categories: PersonalCategories;
  readonly recipients: RecipientsRuntime;
  /**
   * The ports that return each category's data, by category.
   */
  readonly ports: ReadonlyMap<string, readonly string[]>;
  /**
   * The stores kept out of `storage`'s jurisdiction, as a person's export lists them.
   */
  readonly transfers: readonly ExportedTransfer[];
  readonly tenant: string;
  readonly exportId: string;
  /**
   * `runtime.personalData.forgetLedger`'s store, `null` without one.
   */
  readonly ledger: ForgetLedger | null;
  // Since when the tenant is frozen.
  readonly frozenAt: string;
  /**
   * Runs once the header is read and once each page of records is, every value of the page opened,
   * before anything read for it is handed out; what it throws is the export's failure.
   */
  readonly onPage: () => Promise<void>;
}

// The header, read whole, and every part after it, each read only as it is asked for.
export interface StreamedTenantExport {
  readonly header: TenantExportHeader;
  readonly parts: AsyncGenerator<TenantExportRecord | EndPart, void, undefined>;
}

type EndPart = Extract<TenantExportPart, { readonly kind: "end" }>;

export interface StreamTenantExportFunction {
  (args: StreamTenantExportArgs): Promise<StreamedTenantExport>;
}

interface Pages extends AsyncGenerator<readonly TenantExportRecord[], void, undefined> {}

// What restricts the processing of a person's data: a restriction of them as a whole, of some
// categories, or a key a forgetting kept under an erasure exemption, by category.
interface PersonRestrictions {
  readonly whole: boolean;
  readonly requested: ReadonlySet<string | null>;
  readonly kept: ReadonlySet<string>;
}

const NOT_RESTRICTED: PersonRestrictions = { whole: false, requested: new Set(), kept: new Set() };

const TEXT_FIELDS = ["errorMessage", "errorStack"] as const;

const categoriesOf = (marks: PersonalMarks | null, payload: unknown): ExportedCategories => {
  if (marks === null || !isRecord(payload)) return {};
  return Object.fromEntries(
    marks.fields
      .filter((field) => payload[field] !== undefined)
      .map((field) => [field, fieldCategory(marks, field)]),
  );
};

const distinct = (persons: readonly KeyedPerson[] | undefined): readonly string[] => [
  ...new Set((persons ?? []).map(({ person }) => person)),
];

// Pages by a key no write changes, so a record written or removed meanwhile cannot make another
// one skip a page or repeat; the last page is the one shorter than a batch, empty maybe.
async function* paged<Item>(
  read: (after: string | undefined) => Promise<readonly Item[]>,
  keyOf: (item: Item) => string,
  build: (items: readonly Item[]) => Promise<readonly TenantExportRecord[]>,
  batchSize: number,
): Pages {
  let after: string | undefined;
  for (;;) {
    const page = await read(after);
    yield await build(page);
    if (page.length < batchSize) return;
    after = keyOf(page.at(-1) as Item);
  }
}

// Each item's record, in order, one at a time; an item built as `null` has none.
const built = async <Item>(
  items: readonly Item[],
  build: (item: Item) => Promise<TenantExportRecord | null>,
): Promise<readonly TenantExportRecord[]> => {
  const records: TenantExportRecord[] = [];
  for (const item of items) {
    const record = await build(item);
    if (record !== null) records.push(record);
  }
  return records;
};

// Every id two stores list, each in code point order, merged into one such order, each once, a
// page at a time: a store's next page is read before its last id is compared, since an id of it
// yet unread may come before the other's.
async function* mergedIds(
  sources: readonly ((after: string | undefined) => Promise<readonly string[]>)[],
  batchSize: number,
): AsyncGenerator<readonly string[], void, undefined> {
  const cursors = sources.map((read) => ({
    read,
    buffer: [] as string[],
    after: undefined as string | undefined,
    done: false,
  }));
  let page: string[] = [];
  for (;;) {
    for (const cursor of cursors) {
      if (cursor.buffer.length > 0 || cursor.done) continue;
      const read = await cursor.read(cursor.after);
      cursor.buffer = [...read];
      cursor.done = read.length < batchSize;
      cursor.after = read.at(-1) ?? cursor.after;
    }
    const live = cursors.filter(({ buffer }) => buffer.length > 0);
    if (live.length === 0) break;
    const next = live
      .map(({ buffer }) => buffer[0] as string)
      .reduce((least, id) => (codePointOrder(id, least) < 0 ? id : least));
    for (const cursor of live) if (cursor.buffer[0] === next) cursor.buffer.shift();
    page.push(next);
    if (page.length === batchSize) {
      yield page;
      page = [];
    }
  }
  if (page.length > 0) yield page;
}

// Resolves once the header is read and `onPage` let it through, so a refusal rejects before
// anything is handed out. The export is of the stream up to the head its header names: a stream
// that moved past it by the time the last page is read rejects it with `TenantDataChangedError`.
export const streamTenantExport: StreamTenantExportFunction = async ({
  storage,
  aggregates,
  processes,
  readModels,
  sealing,
  clock,
  batchSize,
  categories,
  recipients,
  ports,
  transfers,
  tenant,
  exportId,
  ledger,
  frozenAt,
  onPage,
}) => {
  const exportedAt = clock.now().toISOString();
  const position = await storage.eventStore.lastPosition();
  const projected: Record<string, number> = {};
  for (const { name, storage: own } of Object.values(readModels.byName)) {
    projected[name] = await own.checkpointStore.get(projectionSubscriberName(name));
  }
  const reached = {
    readModels: projected,
    forgetLedger:
      ledger === null ? null : await storage.checkpointStore.get(FORGET_LEDGER_SUBSCRIBER),
  };
  const appCategories: Record<string, TenantExportCategory> = {};
  for (const [name, category] of Object.entries(
    personalDataInformation({ categories, keys: [], person: null }).categories,
  )) {
    const {
      held: _held,
      keptUntil: _keptUntil,
      restrictedUntil: _restrictedUntil,
      ...rest
    } = category;
    appCategories[name] = { ...rest, ports: ports.get(name) ?? [] };
  }
  const header: TenantExportHeader = {
    format: TENANT_EXPORT_FORMAT,
    version: TENANT_EXPORT_VERSION,
    tenant,
    exportId,
    exportedAt,
    position,
    frozenAt,
    reached,
    categories: appCategories,
    transfers,
    readModels: Object.keys(readModels.byName),
  };

  // What restricts each person's data, read once a page and let go with it.
  const restrictionsOfPage = () => {
    const read = new Map<string, Promise<PersonRestrictions>>();
    return (person: string): Promise<PersonRestrictions> => {
      const known = read.get(person);
      if (known !== undefined) return known;
      const reading = (async (): Promise<PersonRestrictions> => {
        const rows = await storage.persons.restrictions(person);
        const keys = await storage.personalKeys.list(person);
        return {
          whole: rows.some(({ category }) => category === null),
          // A restriction of them as a whole, `null`, is `whole`.
          requested: new Set(rows.map(({ category }) => category)),
          kept: new Set(
            keys.filter(({ retainedSince }) => retainedSince !== null).map((key) => key.category),
          ),
        };
      })();
      read.set(person, reading);
      return reading;
    };
  };
  const restrictedOf = (
    of: ExportedCategories,
    restrictions: readonly PersonRestrictions[],
    withKept: boolean,
  ): ExportedRestricted =>
    Object.entries(of)
      .filter(([, category]) =>
        restrictions.some(
          ({ whole, requested, kept }) =>
            whole || requested.has(category) || (withKept && kept.has(category)),
        ),
      )
      .map(([field]) => field);
  const anyRestricted = (restrictions: readonly PersonRestrictions[]): boolean =>
    restrictions.some(({ whole, requested }) => whole || requested.size > 0);
  const restrictionsOfAll = (
    restrictionsOf: (person: string) => Promise<PersonRestrictions>,
    persons: readonly (string | null)[],
  ): Promise<readonly PersonRestrictions[]> =>
    Promise.all(
      persons.map((person) =>
        person === null ? Promise.resolve(NOT_RESTRICTED) : restrictionsOf(person),
      ),
    );
  const commandMarks = (type: string): PersonalMarks | null =>
    aggregates.commandsByType[type]?.command.personal ?? null;
  // A process's lifecycle event holds the fields its state marks, in that state.
  const eventCategories = (event: StoredEvent): ExportedCategories => {
    const process = processOfStream(event.aggregateType);
    if (process === null) {
      const marks = aggregates.byName[event.aggregateType]?.eventsByType[event.type]?.personal;
      return categoriesOf(marks ?? null, event.payload);
    }
    return categoriesOf(
      processes.byName[process]?.personal ?? null,
      lifecycleStateOf(event.payload),
    );
  };

  const tally = tallyRecipients({ recipients, categories });
  const personPages = async function* (): Pages {
    const rows = new Map<string, StoredPerson>();
    const ids = mergedIds(
      [
        async (after) => {
          const page = await storage.persons.scan({ after, limit: batchSize });
          for (const row of page) rows.set(row.person, row);
          return page.map(({ person }) => person);
        },
        (after) => storage.personalKeys.persons({ after, limit: batchSize }),
      ],
      batchSize,
    );
    for await (const page of ids) {
      const keys = await storage.personalKeys.listMany(page);
      const listed = await recipientsOfPage({
        storage,
        recipients,
        categories,
        persons: page,
        keys,
      });
      for (const personId of page) tally.add(listed.get(personId) as readonly PersonRecipient[]);
      yield await built(page, async (personId) => {
        // A person the store keeps a row of is read before their id comes out of the merge.
        const person = rows.get(personId) ?? null;
        rows.delete(personId);
        const information = personalDataInformation({
          categories,
          keys: keys.get(personId) ?? [],
          person,
        });
        return {
          kind: "person",
          person: {
            personId,
            lastActiveAt: person?.lastActiveAt ?? null,
            forgottenAt: person?.forgottenAt ?? null,
            categories: Object.fromEntries(
              Object.entries(information.categories)
                // A key kept past a forgetting is held too.
                .filter(([, { held }]) => held)
                .map(([name, { keptUntil, restrictedUntil }]) => [
                  name,
                  { keptUntil, restrictedUntil },
                ]),
            ),
            // A person has restrictions only while their row says since when.
            restrictions:
              person?.restrictedSince == null
                ? []
                : processingRestrictionsOf(await storage.persons.restrictions(personId)),
            // Every person of the page is listed.
            recipients: listed.get(personId) as readonly PersonRecipient[],
          },
        };
      });
    }
  };

  // Every event up to the head the header names.
  const eventPages = async function* (): Pages {
    let afterPosition = 0;
    while (afterPosition < position) {
      const read = await storage.eventStore.readAll({ afterPosition, limit: batchSize });
      const page = read.filter((event) => event.position <= position);
      const restrictionsOf = restrictionsOfPage();
      yield await built(page, async (event) => {
        const of = eventCategories(event);
        const restrictions = await restrictionsOfAll(restrictionsOf, [event.person]);
        const kept = openedUnder(event).some(({ retained }) => retained === true);
        return {
          kind: "event",
          event: {
            id: event.id,
            type: event.type,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
            version: event.version,
            position: event.position,
            timestamp: event.timestamp,
            metadata: event.metadata,
            person: event.person,
            payload: event.payload,
            categories: of,
            restricted: restrictedOf(of, restrictions, kept),
            redacted: redactedIn(event),
          },
        };
      });
      // The head is an event, so a page that reaches it ends the loop; one that comes back empty
      // before it read a stream that went back, as a restore under the app does.
      const last = page.at(-1);
      if (last === undefined) {
        throw new TenantDataChangedError(tenant, position, await storage.eventStore.lastPosition());
      }
      afterPosition = last.position;
    }
  };

  const scheduledPages = (): Pages =>
    paged(
      (after) => storage.scheduler.scan({ after, limit: batchSize }),
      ({ dedupeKey }) => dedupeKey,
      (entries) => {
        const keyOf = sealedKeys(storage.personalKeys);
        const restrictionsOf = restrictionsOfPage();
        return built(entries, async (entry) => {
          const { payload } = await openCommandPayload({
            payload: entry.command.payload,
            keys: storage.personalKeys,
            keyOf,
          });
          const persons = distinct(entry.persons);
          const of = categoriesOf(commandMarks(entry.command.type), payload);
          return {
            kind: "scheduledCommand",
            scheduledCommand: {
              dedupeKey: entry.dedupeKey,
              type: entry.command.type,
              aggregateId: entry.command.aggregateId,
              payload,
              executeAt: entry.executeAt,
              ...(entry.scheduledAt === undefined ? {} : { scheduledAt: entry.scheduledAt }),
              context: entry.context,
              attempts: entry.attempts,
              persons,
              categories: of,
              restricted: restrictedOf(of, await restrictionsOfAll(restrictionsOf, persons), true),
            },
          };
        });
      },
      batchSize,
    );

  // An error's text, opened, `null` once anyone it is sealed under is forgotten.
  const openedText = async (
    keyOf: ReturnType<typeof sealedKeys>,
    { errorMessage, errorStack }: Pick<StoredDeadLetter, "errorMessage" | "errorStack">,
  ) => {
    const openText = openTextWith(keyOf);
    return {
      errorMessage: await openText(errorMessage),
      ...(errorStack === undefined ? {} : { errorStack: await openText(errorStack) }),
    };
  };
  const textRestricted = (
    restrictions: readonly PersonRestrictions[],
    { errorStack }: Pick<StoredDeadLetter, "errorStack">,
  ): ExportedRestricted =>
    anyRestricted(restrictions)
      ? TEXT_FIELDS.filter((field) => field === "errorMessage" || errorStack !== undefined)
      : [];

  const letterPages = (): Pages =>
    paged(
      (after) => storage.deadLetterStore.scan({ after, limit: batchSize }),
      ({ id }) => id,
      (letters) => {
        const keyOf = sealedKeys(storage.personalKeys);
        const restrictionsOf = restrictionsOfPage();
        return built(letters, async (letter) => {
          const {
            errorMessage: _errorMessage,
            errorStack: _errorStack,
            payload: stored,
            persons: _persons,
            ...rest
          } = letter;
          const { payload: opened } = await openCommandPayload({
            payload: stored,
            keys: storage.personalKeys,
            keyOf,
          });
          const persons = distinct(letter.persons);
          const of = categoriesOf(commandMarks(letter.eventType), opened);
          const restricted = [
            ...restrictedOf(of, await restrictionsOfAll(restrictionsOf, persons), true),
            ...textRestricted(await restrictionsOfAll(restrictionsOf, textPersons(letter)), letter),
          ];
          return {
            kind: "deadLetter",
            deadLetter: {
              ...rest,
              ...(await openedText(keyOf, letter)),
              ...(stored === undefined ? {} : { payload: opened }),
              persons,
              categories: of,
              restricted,
            },
          };
        });
      },
      batchSize,
    );

  // One row per subscriber: few enough to read whole, as one page.
  const failuresPage = async (): Promise<readonly TenantExportRecord[]> => {
    const keyOf = sealedKeys(storage.personalKeys);
    const restrictionsOf = restrictionsOfPage();
    return built(await storage.subscriberFailures.list(), async (failure) => {
      const {
        errorMessage: _errorMessage,
        errorStack: _errorStack,
        ...rest
      }: StoredSubscriberFailure = failure;
      return {
        kind: "subscriberFailure",
        subscriberFailure: {
          ...rest,
          ...(await openedText(keyOf, failure)),
          restricted: textRestricted(
            await restrictionsOfAll(restrictionsOf, textPersons(failure)),
            failure,
          ),
        },
      };
    });
  };

  // An answer a key it is sealed under no longer opens holds nothing to hand out. One kept before
  // keys were filed by their HMAC holds no key of its own, and is filed under it in the clear.
  const answerPages = (): Pages => {
    const now = clock.now();
    return paged(
      (after) => storage.idempotencyStore.list({ now, after, limit: batchSize }),
      ({ key }) => key,
      (records) => {
        const restrictionsOf = restrictionsOfPage();
        return built(records, async (record) => {
          const remembered =
            record.answer === null
              ? null
              : await openAnswer({
                  keys: storage.personalKeys,
                  atRest: storage.atRest,
                  answer: record.answer,
                });
          if (remembered === null) return null;
          const persons = distinct(record.persons);
          return {
            kind: "answer",
            answer: {
              idempotencyKey: remembered.key ?? record.key,
              expiresAt: record.expiresAt,
              outcome: remembered.outcome,
              persons,
              restricted: anyRestricted(await restrictionsOfAll(restrictionsOf, persons))
                ? ["outcome"]
                : [],
            },
          };
        });
      },
      batchSize,
    );
  };

  // Each read model through its own storage, which may be another adapter's, by primary key.
  async function* rowPages(): Pages {
    for (const { name, storage: rows, fields, layout, personalData } of Object.values(
      readModels.byName,
    )) {
      // Every read model has one, which building it checks.
      const [primaryKey] = Object.entries(fields).find(([, field]) => field.isPrimaryKey) as [
        string,
        unknown,
      ];
      let after: unknown;
      for (;;) {
        const page = await rows.table.findMany({
          where: after === undefined ? {} : { [primaryKey]: { gt: after } },
          orderBy: { field: primaryKey, direction: "asc" },
          limit: batchSize,
        });
        const keys = createSealingKeyRing({ keys: sealing.keys, fetching: true });
        const restrictionsOf = restrictionsOfPage();
        yield await built(page, async (stored) => {
          // Every value opened, what a forgetting kept included: the export marks it restricted.
          const { row, retainedFields } = await openRow({
            context: { layout, keys },
            stored,
            hideRetained: false,
          });
          const person =
            personalData === null ? null : ((row[personalData.person] as string | null) ?? null);
          const of: Record<string, string> =
            personalData === null
              ? {}
              : Object.fromEntries(
                  Object.entries(fields)
                    .filter(
                      ([field]) =>
                        personalData.personal.includes(field) && row[field] !== undefined,
                    )
                    .map(([field, { category }]) => [field, category ?? DEFAULT_PERSONAL_CATEGORY]),
                );
          return {
            kind: "row",
            readModel: name,
            row: {
              key: row[primaryKey],
              // Every field of the view, one no key opens any more `null`.
              data: Object.fromEntries(
                Object.keys(fields).map((field) => [field, row[field] ?? null]),
              ),
              person,
              categories: of,
              restricted: [
                ...new Set([
                  ...restrictedOf(of, await restrictionsOfAll(restrictionsOf, [person]), false),
                  ...retainedFields,
                ]),
              ],
            },
          };
        });
        if (page.length < batchSize) break;
        after = (page.at(-1) as Record<string, unknown>)[primaryKey];
      }
    }
  }

  async function* ledgerPages(): Pages {
    if (ledger === null) return;
    let after: ForgetLedgerEntry | undefined;
    for (;;) {
      const page = await ledger.read({
        ...(after === undefined
          ? {}
          : { after: { forgottenAt: after.forgottenAt, eventId: after.eventId } }),
        limit: batchSize,
      });
      yield page.map((entry) => ({ kind: "forgetLedgerEntry", entry }));
      if (page.length < batchSize) return;
      after = page.at(-1);
    }
  }

  async function* pages(): Pages {
    yield* personPages();
    // Once every person is listed, so it sums what their parts said.
    yield tally.recipients().map((recipient) => ({ kind: "recipient", recipient }));
    yield* eventPages();
    yield* scheduledPages();
    yield* letterPages();
    yield await failuresPage();
    yield* answerPages();
    yield* rowPages();
    yield* ledgerPages();
  }

  // Each page is built whole, every key and restriction it opens read, before `onPage` runs, so
  // nothing read for it is handed out unchecked; a page with nothing to hand out needs no check.
  async function* parts(): AsyncGenerator<TenantExportRecord | EndPart, void, undefined> {
    let counts: TenantExportCounts = NO_TENANT_EXPORT_RECORDS;
    for await (const page of pages()) {
      if (page.length === 0) continue;
      await onPage();
      for (const record of page) {
        counts = countTenantRecord(counts, record);
        yield record;
      }
    }
    const head = await storage.eventStore.lastPosition();
    if (head !== position) throw new TenantDataChangedError(tenant, position, head);
    yield { kind: "end", counts };
  }

  await onPage();
  return { header, parts: parts() };
};

export interface RecordedTenantExportArgs {
  readonly streamed: StreamedTenantExport;
  readonly record: (
    outcome: ExportOutcome,
    error: unknown,
    counts: TenantExportCounts,
    persons: readonly string[],
  ) => Promise<void>;
  readonly onError: (error: unknown) => void;
}

export interface RecordedTenantExportFunction {
  (args: RecordedTenantExportArgs): Promise<AsyncGenerator<TenantExportPart, void, undefined>>;
}

async function* ended({
  streamed: { header, parts },
  record,
  onError,
}: RecordedTenantExportArgs): AsyncGenerator<TenantExportPart, void, undefined> {
  let counts = NO_TENANT_EXPORT_RECORDS;
  const persons: string[] = [];
  let outcome: ExportOutcome = "cancelled";
  let failure: unknown;
  try {
    yield { kind: "header", header };
    for await (const part of parts) {
      if (part.kind !== "end") {
        counts = countTenantRecord(counts, part);
        if (part.kind === "person" && persons.length < MAX_ACCESS_PERSONS) {
          persons.push(part.person.personId);
        }
      }
      yield part;
    }
    outcome = "ok";
  } catch (error) {
    outcome = "failed";
    failure = error;
    onError(error);
    throw error;
  } finally {
    await record(outcome, failure, counts, persons);
  }
}

// Recorded `started` before the header is handed out, then however the reading ends, as a
// person's export is.
export const recordedTenantExport: RecordedTenantExportFunction = async (args) => {
  await args.record("started", undefined, NO_TENANT_EXPORT_RECORDS, []);
  return ended(args);
};
