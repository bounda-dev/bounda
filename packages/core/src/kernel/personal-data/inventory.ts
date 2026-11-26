import type { z } from "zod";
import { type AdapterDefinition, isAdapterDefinition } from "../../adapter/adapter-definition.ts";
import { resolveConfig } from "../../config/schema.ts";
import type { Config, ResolvedConfig } from "../../config/types.ts";
import type { DataLocation, LegalRegime } from "../../modules/data-location.ts";
import { capitalize } from "../../modules/naming.ts";
import type {
  AutomatedDecision,
  CriminalOffenceData,
  LegalBasis,
  PersonalDataSource,
  SpecialCategoryData,
  SpecificPurpose,
} from "../../modules/personal-data.ts";
import type {
  CountryCode,
  PartialAdequacy,
  RecipientKind,
  RecipientTransfer,
  StoreSafeguard,
} from "../../modules/recipient.ts";
import type { Registry } from "../../modules/registry.ts";
import { type FieldsRecord, fieldBuilder } from "../../modules/view.ts";
import { schemaArgs } from "../aggregate/build-aggregates.ts";
import { buildPortReturns, portsByCategory } from "../ports/returns.ts";
import { processStateArgs } from "../process/deadlines.ts";
import { checkRecipientTransfer } from "../recipients/build.ts";
import { recipientTransferOf } from "../recipients/transfer.ts";
import { buildPersonalCategories, formatRetention } from "./categories.ts";
import {
  classifySchema,
  classifyView,
  type FieldClassification,
  schemaOf,
} from "./classification.ts";
import { EXEMPTION_ARTICLES, type ExportedErasureExemption } from "./export.ts";
import { looksPersonal, looksSpecial } from "./looks-personal.ts";
import { fieldCategory, personalMarksOf } from "./marks.ts";
import { storeTransfer } from "./transfers.ts";

/**
 * What holds personal data: an event's payload, a command's, a process's state, or a read
 * model's row.
 */
export type InventoryHolderKind = "event" | "command" | "process-state" | "read-model";

/**
 * Where the runtime keeps a copy of a holder's fields: the stream (`event-store`, a process's
 * lifecycle events included), the aggregate's `snapshots`, the `scheduled-commands` of a command
 * dispatched with `delay` or retried, the `dead-letters` of one that gave up, and the read model's
 * table.
 */
export type InventoryStore =
  | "event-store"
  | "snapshots"
  | "scheduled-commands"
  | "dead-letters"
  | "read-model";

/**
 * How a personal field is kept: `sealed` under the key of its person and category;
 * `sealed-indexed`, a read-model column sealed and found by its blind index; `clear`, a read-model
 * column in the clear, which only the read model's projection of `PersonalDataForgotten` forgets.
 */
export type InventorySealing = "sealed" | "sealed-indexed" | "clear";

export interface InventoryField {
  readonly name: string;
  readonly category: string;
  readonly sealing: InventorySealing;
}

export interface InventoryHolder {
  readonly kind: InventoryHolderKind;
  /**
   * `<aggregate>.<EventType>` for an event, `<aggregate>.<command>` for a command,
   * `<aggregate>.<process>` for a process's state, the read model's name for a read model.
   */
  readonly name: string;
  /**
   * The field naming whose the data is; `null` when the aggregate's id names them, or the process
   * instance's.
   */
  readonly person: string | null;
  readonly fields: readonly InventoryField[];
  readonly stores: readonly InventoryStore[];
  /**
   * The name of the adapter of the database that keeps them.
   */
  readonly database: string;
  /**
   * Where that database keeps them, as its adapter's `location` declares it; `null` when it
   * declares none.
   */
  readonly location: DataLocation | null;
  /**
   * The safeguard that allows keeping them there, under another legal regime than `storage`'s;
   * `null` when they are kept where `storage` is.
   */
  readonly transfer: InventoryTransfer | null;
}

/**
 * The safeguard of chapter V of the GDPR a store kept under another legal regime than `storage`'s
 * declares, with the article it rests on: the transfer article 30(1)(e) asks the record to name.
 */
export interface InventoryTransfer {
  readonly safeguard: StoreSafeguard;
  readonly article: string;
  /**
   * The legal regime the store is under, as `regimeOf` names its location.
   */
  readonly regime: LegalRegime;
  /**
   * The decision of `PARTIAL_ADEQUACY` the store rests on, whose `condition` you verify of the
   * provider keeping it; `null` unless the safeguard is `adequacy` under the regime of a country
   * of `PARTIAL_ADEQUACY`.
   */
  readonly partialAdequacy: PartialAdequacy | null;
}

export interface InventoryCategory {
  readonly name: string;
  /**
   * `null` for the default category, which declares none.
   */
  readonly basis: LegalBasis | null;
  /**
   * The special categories of data it holds and their condition of article 9(2); `null` for none.
   */
  readonly special: SpecialCategoryData | null;
  /**
   * The authority of article 10 it processes criminal data under; `null` for none.
   */
  readonly criminal: CriminalOffenceData | null;
  /**
   * None for the default category.
   */
  readonly purposes: readonly string[];
  /**
   * The purposes the GDPR has rules of its own for; none when it declares none.
   */
  readonly processedFor: readonly SpecificPurpose[];
  /**
   * The exemptions of article 17(3) that keep it past a forgetting; none when erasure reaches it.
   */
  readonly erasureExemptions: readonly ExportedErasureExemption[];
  readonly sources: readonly PersonalDataSource[];
  /**
   * The ports whose calls return data of it, by `<aggregate or read model>.<port>`, as their
   * `returnsPersonalData` says: where it comes from besides what the app is given.
   */
  readonly ports: readonly string[];
  /**
   * How long after the person's last activity the category is forgotten, as configuration writes
   * it; `null` when nothing forgets it for inactivity.
   */
  readonly retention: string | null;
  /**
   * How many personal fields are in it.
   */
  readonly fields: number;
}

export interface InventoryAutomatedDecision extends AutomatedDecision<string> {
  readonly name: string;
}

export interface InventoryRecipient {
  /**
   * `<aggregate or read model>.<port>`.
   */
  readonly port: string;
  readonly name: string;
  readonly kind: RecipientKind;
  readonly country: CountryCode;
  /**
   * The transfer when the country is outside the European Economic Area; `null` inside it.
   */
  readonly transfer: RecipientTransfer | null;
  readonly categories: readonly string[];
}

/**
 * What the runtime keeps about persons besides the fields of the holders: their keys
 * (`personal-keys`), their activity and restriction (`persons`), the runtime's events about them
 * (`forgettings`), the answers remembered for idempotent commands (`remembered-answers`), the error
 * text of failed work (`dead-letters`) and of each subscriber's last failure
 * (`subscriber-failures`), what went to each recipient (`disclosures`), the master key that
 * wraps every tenant's key (`master-key`), the tenant's key that every personal key is wrapped
 * under, kept apart (`tenant-keys`), the forgettings recorded
 * outside the database (`forget-ledger`), the accesses handed to `app/audit.ts` (`access-log`) and
 * the requests refused before the app served them, handed there too (`host-log`).
 */
export type InventoryRecordName =
  | "personal-keys"
  | "persons"
  | "forgettings"
  | "remembered-answers"
  | "dead-letters"
  | "subscriber-failures"
  | "disclosures"
  | "master-key"
  | "tenant-keys"
  | "forget-ledger"
  | "access-log"
  | "host-log";

export interface InventoryRecord {
  readonly name: InventoryRecordName;
  /**
   * The name of the adapter of the database that keeps it, `"key-wrapper"` for the master key,
   * `"tenant-keys"` for the tenant key store, `"forget-ledger"` for the ledger and
   * `"app/audit.ts"` for the access log and the host log.
   */
  readonly where: string;
  /**
   * Where it is kept, as the `location` of its adapter or store declares it; `null` when it
   * declares none, and for the access log and the host log, which the app keeps where it chooses.
   */
  readonly location: DataLocation | null;
  /**
   * The safeguard that allows keeping it there, under another legal regime than `storage`'s;
   * `null` when it is kept where `storage` is.
   */
  readonly transfer: InventoryTransfer | null;
  /**
   * How long an entry is kept, as configuration writes it, when a setting bounds it; `null`
   * otherwise.
   */
  readonly keptFor: string | null;
}

export interface InventoryNotPersonal {
  readonly kind: InventoryHolderKind;
  readonly name: string;
  readonly field: string;
}

/**
 * Why the record is not complete: `unclassified`, a field that can hold text and is marked
 * neither personal nor not; `looks-personal`, an unmarked field whose name says personal data;
 * `looks-special`, a personal field whose name says special categories of data (article 9) or
 * criminal data (article 10), in a category that does not declare them; `unmarkable`, text a mark
 * cannot reach (a payload that is not an object, or an object that keeps keys it does not
 * declare); `no-basis`, personal fields in the default category, which declares no legal basis;
 * `error-text`, logs that carry the text of errors, which may quote personal data; `no-location`,
 * a store of personal data, or the key wrapper, that declares no `location`, so the record cannot
 * say whether it is a transfer out of the European Economic Area (article 30(1)(e)).
 */
export type InventoryFindingKind =
  | "unclassified"
  | "looks-personal"
  | "looks-special"
  | "unmarkable"
  | "no-basis"
  | "error-text"
  | "no-location";

export interface InventoryFinding {
  readonly kind: InventoryFindingKind;
  /**
   * The holder, as `InventoryHolder.name` names it, `null` for the app as a whole.
   */
  readonly holder: string | null;
  readonly field: string | null;
  readonly message: string;
}

/**
 * The record of processing activities of article 30 of the GDPR, as far as the app's code and
 * configuration say it: what is personal, whose, in which category, on which basis, for how long,
 * where it is kept and how, and who receives it, with what keeps the record from being complete.
 */
export interface PersonalDataInventory {
  readonly categories: readonly InventoryCategory[];
  /**
   * The decisions `app/personal-data.ts` says the app makes about a person by automated means
   * alone, by name.
   */
  readonly automatedDecisions: readonly InventoryAutomatedDecision[];
  readonly holders: readonly InventoryHolder[];
  readonly recipients: readonly InventoryRecipient[];
  readonly records: readonly InventoryRecord[];
  /**
   * Fields marked `notPersonal`: decided, and listed for whoever reviews the record.
   */
  readonly notPersonal: readonly InventoryNotPersonal[];
  /**
   * Whether keys are wrapped under a master key the configuration names, and a tenant key store
   * kept apart; `false` for a storage that brings its own, as `memory()` does.
   */
  readonly security: {
    readonly masterKey: boolean;
    readonly tenantKeys: boolean;
    readonly forgetLedger: boolean;
  };
  /**
   * Empty when the record is complete.
   */
  readonly findings: readonly InventoryFinding[];
}

export interface PersonalDataInventoryArgs {
  readonly registry: Registry;
  readonly config: Config;
}

export interface PersonalDataInventoryFunction {
  (args: PersonalDataInventoryArgs): PersonalDataInventory;
}

const msText = (ms: number | null): string | null =>
  ms === null ? null : formatRetention({ months: 0, ms });

interface Collected {
  readonly holders: InventoryHolder[];
  readonly notPersonal: InventoryNotPersonal[];
  readonly findings: InventoryFinding[];
}

interface MarkedField {
  readonly name: string;
  readonly mark: NonNullable<FieldClassification>["mark"] | null;
  readonly holdsText: boolean;
}

const review = (
  collected: Collected,
  kind: InventoryHolderKind,
  holder: string,
  fields: readonly MarkedField[],
): void => {
  for (const field of fields) {
    if (field.mark === "not-personal") {
      collected.notPersonal.push({ kind, name: holder, field: field.name });
    }
    if (field.mark !== null) continue;
    const word = looksPersonal(field.name);
    if (word !== null) {
      collected.findings.push({
        kind: "looks-personal",
        holder,
        field: field.name,
        message: `${holder}: field "${field.name}" is named like personal data ("${word}") and is not marked; mark it personal or notPersonal`,
      });
    } else if (field.holdsText) {
      collected.findings.push({
        kind: "unclassified",
        holder,
        field: field.name,
        message: `${holder}: field "${field.name}" can hold text and is not marked; mark it personal or notPersonal`,
      });
    }
  }
};

interface KeptIn {
  readonly database: string;
  readonly location: DataLocation | null;
  readonly transfer: InventoryTransfer | null;
}

// `resolveConfig` lets a store declare a safeguard only beside a location out of `storage`'s legal
// regime.
const transferOf = ({
  location,
  safeguard,
}: {
  readonly location?: DataLocation | undefined;
  readonly safeguard?: StoreSafeguard | undefined;
}): InventoryTransfer | null =>
  location === undefined || safeguard === undefined ? null : storeTransfer(location, safeguard);

const keptIn = (definition: AdapterDefinition): KeptIn => ({
  database: definition.name,
  location: definition.location ?? null,
  transfer: transferOf(definition),
});

const reviewSchema = (
  collected: Collected,
  kind: Exclude<InventoryHolderKind, "read-model">,
  holder: string,
  schema: z.ZodType,
  stores: readonly InventoryStore[],
  kept: KeptIn,
): void => {
  const classified = classifySchema(schema);
  review(
    collected,
    kind,
    holder,
    classified.fields.map((field) => ({ ...field, mark: field.classification?.mark ?? null })),
  );
  if (classified.unmarkableText) {
    collected.findings.push({
      kind: "unmarkable",
      holder,
      field: null,
      message: `${holder}: can hold text no mark reaches; make it an object that keeps only the keys it declares, and mark its fields`,
    });
  }
  // What the runtime seals, read as it reads it: two persons are refused here as at boot.
  const marks = personalMarksOf({ schema, path: holder });
  if (marks === null) return;
  collected.holders.push({
    kind,
    name: holder,
    person: marks.person,
    fields: marks.fields.map((field) => ({
      name: field,
      category: fieldCategory(marks, field),
      sealing: "sealed",
    })),
    stores,
    ...kept,
  });
};

const sealingOf = (field: FieldsRecord[string]): InventorySealing =>
  field.clear ? "clear" : field.isIndexed || field.isUnique ? "sealed-indexed" : "sealed";

const collect = (registry: Registry, config: ResolvedConfig): Collected => {
  const collected: Collected = { holders: [], notPersonal: [], findings: [] };
  const storage = keptIn(config.storage);
  for (const [aggregate, entry] of Object.entries(registry.aggregates)) {
    const snapshots = config.forAggregate(aggregate).snapshot !== null;
    for (const [key, module] of Object.entries(entry.events)) {
      const schema = schemaOf(module.payload, schemaArgs);
      if (schema === null) continue;
      reviewSchema(
        collected,
        "event",
        `${aggregate}.${capitalize(key)}`,
        schema,
        snapshots ? ["event-store", "snapshots"] : ["event-store"],
        storage,
      );
    }
    for (const [key, command] of Object.entries(entry.commands)) {
      const schema = schemaOf(command.module.payload, schemaArgs);
      if (schema === null) continue;
      reviewSchema(
        collected,
        "command",
        `${aggregate}.${key}`,
        schema,
        ["scheduled-commands", "dead-letters"],
        storage,
      );
    }
    for (const [key, process] of Object.entries(entry.processes)) {
      const schema = schemaOf(process.module.state, processStateArgs);
      if (schema === null) continue;
      reviewSchema(
        collected,
        "process-state",
        `${aggregate}.${key}`,
        schema,
        ["event-store"],
        storage,
      );
    }
  }
  for (const [name, entry] of Object.entries(registry.readModels)) {
    const fields = entry.view.fields({ f: fieldBuilder });
    review(collected, "read-model", name, classifyView(fields));
    const person = Object.entries(fields).find(([, field]) => field.mark === "person")?.[0];
    const personal = Object.entries(fields).filter(([, field]) => field.mark === "personal");
    if (person === undefined && personal.length === 0) continue;
    collected.holders.push({
      kind: "read-model",
      name,
      person: person ?? null,
      fields: personal.map(([field, definition]) => ({
        name: field,
        category: definition.category ?? "default",
        sealing: sealingOf(definition),
      })),
      stores: ["read-model"],
      ...(config.readModels[name] === undefined ? storage : keptIn(config.readModels[name])),
    });
  }
  return collected;
};

const recipientsOf = (registry: Registry): InventoryRecipient[] =>
  [...Object.entries(registry.aggregates), ...Object.entries(registry.readModels)].flatMap(
    ([owner, entry]) =>
      Object.entries(entry.recipients ?? {}).map(([port, module]) => {
        const { recipient } = module;
        // A record drawn without the app still names no transfer the app would refuse.
        checkRecipientTransfer(
          `${owner}.${port}`,
          recipient as unknown as Readonly<Record<string, unknown>>,
        );
        return {
          port: `${owner}.${port}`,
          name: recipient.name.trim(),
          kind: recipient.kind,
          country: recipient.country,
          transfer: recipientTransferOf(recipient.country, recipient.safeguard ?? null),
          categories: [...recipient.categories],
        };
      }),
  );

const recordsOf = (
  registry: Registry,
  config: ResolvedConfig,
  recipients: readonly InventoryRecipient[],
): InventoryRecord[] => {
  const { database: where, ...placed } = keptIn(config.storage);
  const storage = { where, ...placed };
  const { keyWrapper, tenantKeys, forgetLedger: ledger } = config.runtime.personalData;
  return [
    { name: "personal-keys", ...storage, keptFor: null },
    { name: "persons", ...storage, keptFor: null },
    { name: "forgettings", ...storage, keptFor: null },
    {
      name: "remembered-answers",
      ...storage,
      keptFor: msText(config.runtime.commands.idempotencyKeyLifetimeMs),
    },
    {
      name: "dead-letters",
      ...storage,
      keptFor: msText(config.runtime.deadLetters.retentionMs),
    },
    {
      name: "subscriber-failures",
      ...storage,
      keptFor: msText(config.runtime.subscriberFailures.retentionMs),
    },
    ...(recipients.length === 0
      ? []
      : [{ name: "disclosures" as const, ...storage, keptFor: null }]),
    ...(keyWrapper === null
      ? []
      : [
          {
            name: "master-key" as const,
            where: "key-wrapper",
            location: keyWrapper.location ?? null,
            transfer: transferOf(keyWrapper),
            keptFor: null,
          },
        ]),
    ...(tenantKeys === null
      ? []
      : [
          {
            name: "tenant-keys" as const,
            where: "tenant-keys",
            location: tenantKeys.location ?? null,
            transfer: transferOf(tenantKeys),
            keptFor: null,
          },
        ]),
    ...(ledger === null
      ? []
      : [
          {
            name: "forget-ledger" as const,
            where: "forget-ledger",
            location: ledger.store.location ?? null,
            transfer: transferOf(ledger.store),
            keptFor: msText(ledger.keepForMs),
          },
        ]),
    ...(registry.audit === undefined
      ? []
      : [
          {
            name: "access-log" as const,
            where: "app/audit.ts",
            location: null,
            transfer: null,
            keptFor: null,
          },
          {
            name: "host-log" as const,
            where: "app/audit.ts",
            location: null,
            transfer: null,
            keptFor: null,
          },
        ]),
  ];
};

interface Placed {
  readonly path: string;
  readonly declared: object;
  readonly through: string;
}

const optionsOf = (adapter: AdapterDefinition): string => `the options of its ${adapter.name}()`;

const declaredThrough = (declared: object, define: string): string =>
  isAdapterDefinition(declared) ? optionsOf(declared) : `${define}(create, { location })`;

// Each store of personal data that declares no location; under a storage that declares one,
// `resolveConfig` has refused the configuration already.
const unlocated = (
  config: ResolvedConfig,
  holders: readonly InventoryHolder[],
  recipients: readonly InventoryRecipient[],
): InventoryFinding[] => {
  // Nothing personal, nothing to place: a disclosure alone still names its person in storage.
  if (holders.length === 0 && recipients.length === 0) return [];
  const { storage, readModels } = config;
  const { keyWrapper, tenantKeys, forgetLedger } = config.runtime.personalData;
  const stores: Placed[] = [
    { path: "storage", declared: storage, through: optionsOf(storage) },
    ...holders.flatMap((holder) => {
      const definition = holder.kind === "read-model" ? readModels[holder.name] : undefined;
      return definition === undefined || definition === storage
        ? []
        : [
            {
              path: `readModels.${holder.name}`,
              declared: definition,
              through: optionsOf(definition),
            },
          ];
    }),
    ...(keyWrapper === null
      ? []
      : [
          {
            path: "runtime.personalData.keyWrapper",
            declared: keyWrapper,
            through: "masterKey({ from, location }) or defineKeyWrapper(create, { location })",
          },
        ]),
    ...(tenantKeys === null
      ? []
      : [
          {
            path: "runtime.personalData.tenantKeys",
            declared: tenantKeys,
            through: declaredThrough(tenantKeys, "defineTenantKeyStore"),
          },
        ]),
    ...(forgetLedger === null
      ? []
      : [
          {
            path: "runtime.personalData.forgetLedger.store",
            declared: forgetLedger.store,
            through: declaredThrough(forgetLedger.store, "defineForgetLedger"),
          },
        ]),
  ];
  return stores
    .filter(({ declared }) => Reflect.get(declared, "location") === undefined)
    .map(({ path, through }) => ({
      kind: "no-location",
      holder: null,
      field: null,
      message: `${path} declares no location, so the record cannot say where it is kept, nor whether keeping it there is a transfer out of the European Economic Area (article 30(1)(e)); declare one through ${through}`,
    }));
};

/**
 * The record of processing activities (article 30) the app's registry and configuration hold: what
 * personal data is kept where, by whom it is received and on what each transfer rests, and what the
 * runtime keeps about persons. Throws `ConfigurationError` where the app would refuse to start: a
 * store kept where it may not be, or a recipient whose transfer no declared safeguard allows.
 */
export const personalDataInventory: PersonalDataInventoryFunction = ({ registry, config }) => {
  const resolved = resolveConfig(config);
  const categories = buildPersonalCategories({
    module: registry.personalData,
    retention: resolved.runtime.personalData.retention,
  });
  const collected = collect(registry, resolved);
  const counts = new Map<string, number>();
  for (const holder of collected.holders) {
    for (const field of holder.fields) {
      counts.set(field.category, (counts.get(field.category) ?? 0) + 1);
    }
  }
  const findings = [...collected.findings];
  for (const holder of collected.holders) {
    for (const field of holder.fields) {
      const category = categories.of(field.category);
      const said = looksSpecial(field.name).find(
        ({ special, criminal }) =>
          !((special && category?.special) || (criminal && category?.criminal)),
      );
      if (said === undefined) continue;
      const data = [
        ...(said.special ? ["special categories of data (article 9)"] : []),
        ...(said.criminal ? ["criminal data (article 10)"] : []),
      ].join(" or ");
      findings.push({
        kind: "looks-special",
        holder: holder.name,
        field: field.name,
        message: `${holder.name}: field "${field.name}" is named like ${data} ("${said.word}") and is in the category "${field.category}", which does not declare them; declare them in a category of app/personal-data.ts and give the field that category`,
      });
    }
  }
  const unbased = counts.get("default") ?? 0;
  if (unbased > 0) {
    findings.push({
      kind: "no-basis",
      holder: null,
      field: null,
      message: `${unbased} personal field${unbased === 1 ? " is" : "s are"} in the default category, which declares no legal basis, purpose or source; declare categories in app/personal-data.ts and give each field one`,
    });
  }
  if (resolved.runtime.telemetry.errorText === "include") {
    findings.push({
      kind: "error-text",
      holder: null,
      field: null,
      message:
        'runtime.telemetry.errorText is "include": logs and spans carry the text of errors, which may quote personal data no forgetting reaches',
    });
  }
  const recipients = recipientsOf(registry);
  findings.push(...unlocated(resolved, collected.holders, recipients));
  const returning = portsByCategory(buildPortReturns({ registry, categories }));
  return {
    categories: categories.all.map((category) => ({
      name: category.name,
      basis: category.basis,
      special: category.special,
      criminal: category.criminal,
      purposes: category.purposes,
      processedFor: category.processedFor,
      erasureExemptions: category.exemptions.map((exemption) => ({
        exemption,
        article: EXEMPTION_ARTICLES[exemption],
      })),
      sources: category.sources,
      ports: returning.get(category.name) ?? [],
      retention: category.retention === null ? null : formatRetention(category.retention),
      fields: counts.get(category.name) ?? 0,
    })),
    automatedDecisions: categories.decisions,
    holders: collected.holders,
    recipients,
    records: recordsOf(registry, resolved, recipients),
    notPersonal: collected.notPersonal,
    security: {
      masterKey: resolved.runtime.personalData.keyWrapper !== null,
      tenantKeys: resolved.runtime.personalData.tenantKeys !== null,
      forgetLedger: resolved.runtime.personalData.forgetLedger !== null,
    },
    findings,
  };
};
