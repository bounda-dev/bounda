import type { z } from "zod";
import type { AdapterDefinition } from "../../adapter/adapter-definition.ts";
import { resolveConfig } from "../../config/schema.ts";
import type { Config, ResolvedConfig } from "../../config/types.ts";
import { capitalize } from "../../modules/naming.ts";
import type {
  AutomatedDecision,
  LegalBasis,
  PersonalDataSource,
} from "../../modules/personal-data.ts";
import type { RecipientKind, TransferSafeguard } from "../../modules/recipient.ts";
import type { Registry } from "../../modules/registry.ts";
import { type FieldsRecord, fieldBuilder } from "../../modules/view.ts";
import { schemaArgs } from "../aggregate/build-aggregates.ts";
import { processStateArgs } from "../process/deadlines.ts";
import { buildPersonalCategories, formatRetention } from "./categories.ts";
import {
  classifySchema,
  classifyView,
  type FieldClassification,
  schemaOf,
} from "./classification.ts";
import { looksPersonal } from "./looks-personal.ts";
import { fieldCategory, personalMarksOf } from "./marks.ts";

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
   * Where that database keeps them, as its adapter's definition pins it (`location`); `null`
   * when it pins nothing.
   */
  readonly location: string | null;
}

export interface InventoryCategory {
  readonly name: string;
  /**
   * `null` for the default category, which declares none.
   */
  readonly basis: LegalBasis | null;
  /**
   * None for the default category.
   */
  readonly purposes: readonly string[];
  readonly sources: readonly PersonalDataSource[];
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

export interface InventoryAutomatedDecision extends AutomatedDecision {
  readonly name: string;
}

export interface InventoryRecipient {
  /**
   * `<aggregate or read model>.<port>`.
   */
  readonly port: string;
  readonly name: string;
  readonly kind: RecipientKind;
  readonly country: string;
  /**
   * `null` inside the European Economic Area.
   */
  readonly safeguard: TransferSafeguard | null;
  readonly categories: readonly string[];
}

/**
 * What the runtime keeps about persons besides the fields of the holders: their keys
 * (`personal-keys`), their activity and restriction (`persons`), the runtime's events about them
 * (`forgettings`), the answers remembered for idempotent commands (`remembered-answers`), the error
 * text of failed work (`dead-letters`), what went to each recipient (`disclosures`), the
 * forgettings recorded outside the database (`forget-ledger`) and the accesses handed to
 * `app/audit.ts` (`access-log`).
 */
export type InventoryRecordName =
  | "personal-keys"
  | "persons"
  | "forgettings"
  | "remembered-answers"
  | "dead-letters"
  | "disclosures"
  | "forget-ledger"
  | "access-log";

export interface InventoryRecord {
  readonly name: InventoryRecordName;
  /**
   * The name of the adapter of the database that keeps it, `"forget-ledger"` for the ledger and
   * `"app/audit.ts"` for the access log.
   */
  readonly where: string;
  /**
   * Where that database keeps it, as its adapter's definition pins it (`location`); `null` when
   * it pins nothing, and for the ledger and the access log.
   */
  readonly location: string | null;
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
 * `unmarkable`, text a mark cannot reach (a payload that is not an object, or an object that keeps
 * keys it does not declare); `no-basis`, personal fields in the default category, which declares
 * no legal basis; `error-text`, logs that carry the text of errors, which may quote personal data.
 */
export type InventoryFindingKind =
  | "unclassified"
  | "looks-personal"
  | "unmarkable"
  | "no-basis"
  | "error-text";

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
  readonly location: string | null;
}

const keptIn = (definition: AdapterDefinition): KeptIn => ({
  database: definition.name,
  location: definition.location ?? null,
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
        return {
          port: `${owner}.${port}`,
          name: recipient.name.trim(),
          kind: recipient.kind,
          country: recipient.country,
          safeguard: recipient.safeguard ?? null,
          categories: [...recipient.categories],
        };
      }),
  );

const recordsOf = (
  registry: Registry,
  config: ResolvedConfig,
  recipients: readonly InventoryRecipient[],
): InventoryRecord[] => {
  const { database: storage, location } = keptIn(config.storage);
  const ledger = config.runtime.personalData.forgetLedger;
  return [
    { name: "personal-keys", where: storage, location, keptFor: null },
    { name: "persons", where: storage, location, keptFor: null },
    { name: "forgettings", where: storage, location, keptFor: null },
    {
      name: "remembered-answers",
      where: storage,
      location,
      keptFor: msText(config.runtime.commands.idempotencyKeyLifetimeMs),
    },
    {
      name: "dead-letters",
      where: storage,
      location,
      keptFor: msText(config.runtime.deadLetters.retentionMs),
    },
    ...(recipients.length === 0
      ? []
      : [{ name: "disclosures" as const, where: storage, location, keptFor: null }]),
    ...(ledger === null
      ? []
      : [
          {
            name: "forget-ledger" as const,
            where: "forget-ledger",
            location: null,
            keptFor: msText(ledger.keepForMs),
          },
        ]),
    ...(registry.audit === undefined
      ? []
      : [{ name: "access-log" as const, where: "app/audit.ts", location: null, keptFor: null }]),
  ];
};

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
  return {
    categories: categories.all.map((category) => ({
      name: category.name,
      basis: category.basis,
      purposes: category.purposes,
      sources: category.sources,
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
