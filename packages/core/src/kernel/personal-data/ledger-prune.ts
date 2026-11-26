import { type Adapter, isAdapter, type Storage } from "../../adapter/adapter.ts";
import type {
  ForgetLedger,
  ForgetLedgerEntry,
  ForgetLedgerPosition,
} from "../../adapter/storage/forget-ledger.ts";
import { resolveConfig } from "../../config/schema.ts";
import type { Config, ResolvedConfig } from "../../config/types.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { BOUNDA_AGGREGATE } from "../../modules/bounda-events.ts";
import type { Registry } from "../../modules/registry.ts";
import { validateRegistry } from "../../modules/validate.ts";
import type { AppEnv } from "../../register/index.ts";
import { buildAggregates } from "../aggregate/build-aggregates.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { buildProcesses, type ProcessesRuntime } from "../process/build-processes.ts";
import { disclosureHeld, forgottenSince } from "../recipients/again.ts";
import { runtimeText } from "../shared/runtime-text.ts";
import { tenantIdOf } from "../tenant.ts";
import { buildPersonalCategories, type PersonalCategories } from "./categories.ts";
import { withEncryptedFiles } from "./encrypted-files.ts";
import {
  type ForgetLedgerSource,
  openForgetLedger,
  physicalStoreOf,
  storeOf,
} from "./forget-ledger.ts";
import { keySourcesOf } from "./key-hierarchy.ts";
import {
  coverageOf,
  type DatabaseStand,
  dueKeysOf,
  FORGET_LEDGER_CURSOR,
  FORGET_LEDGER_PAGE,
  FORGET_LEDGER_REREAD_MS,
  standOf,
  standsShortOf,
} from "./reconciliation.ts";
import { redactionSeals } from "./redaction.ts";
import { restrictionDue } from "./restriction.ts";
import { appRetentionDue } from "./retention.ts";
import { openTenantKeyStore } from "./tenant-key-source.ts";

export type AppliedStorage = Pick<
  Storage,
  "checkpointStore" | "eventStore" | "recipients" | "fence" | "personalKeys" | "persons"
>;

// What the app decides an entry with, as its reconciliation does: its categories, what its
// aggregates' and processes' events mark personal, and its retention.
export interface ReconciliationRules {
  readonly categories: PersonalCategories;
  readonly aggregates: AggregatesRuntime;
  readonly processes: Pick<ProcessesRuntime, "byName">;
  readonly batchSize: number;
}

export interface ReconciliationRulesOfArgs {
  readonly registry: Registry;
  readonly config: ResolvedConfig;
}

export interface ReconciliationRulesOfFunction {
  (args: ReconciliationRulesOfArgs): ReconciliationRules;
}

// Built from the registry and the configuration as an app builds them at its start, refused as it
// refuses them; no port is needed, since what an event marks is all a redaction reads of its
// aggregate.
export const reconciliationRulesOf: ReconciliationRulesOfFunction = ({ registry, config }) => {
  validateRegistry(registry);
  const aggregates = buildAggregates({ registry, ports: {} });
  return {
    categories: buildPersonalCategories({
      module: registry.personalData,
      retention: config.runtime.personalData.retention,
    }),
    aggregates,
    processes: buildProcesses({ registry, aggregates, config }),
    batchSize: config.runtime.dispatcher.batchSize,
  };
};

export interface PruneAsAppliedArgs {
  readonly ledger: Pick<ForgetLedger, "read" | "fence"> & Required<Pick<ForgetLedger, "prune">>;
  // Whether the tenant is known forgotten outside the ledger, as its tenant key store knows it.
  readonly forgotten: () => Promise<boolean>;
  // `null` for a database that holds no table yet.
  readonly withStorage: <T>(work: (storage: AppliedStorage | null) => Promise<T>) => Promise<T>;
  // Asked once a database is open.
  readonly rules: () => ReconciliationRules;
  readonly keepForMs: number;
  readonly now: Date;
  // Whether the database's reconciliation reads this ledger, as it reads the one its configuration
  // names: its cursor then says what it will not read again. No reconciliation reads another, so
  // an entry there goes only once the database holds what it records or nothing can apply it.
  readonly followed: boolean;
  // Not followed, the ledger the configuration names, opened only to tell whether an entry kept
  // is stranded.
  readonly named?: <T>(work: (ledger: Pick<ForgetLedger, "read">) => Promise<T>) => Promise<T>;
  readonly pageSize?: number;
}

export interface PrunedAsApplied {
  readonly before: string;
  // `before` stopped short of `keepFor`, at the oldest entry the database has yet to apply.
  readonly unapplied: boolean;
}

export interface PruneAsAppliedFunction {
  (args: PruneAsAppliedArgs): Promise<PrunedAsApplied>;
}

export interface HeldEntryFunction {
  (
    storage: Pick<AppliedStorage, "eventStore" | "recipients">,
    entry: ForgetLedgerEntry,
  ): Promise<boolean>;
}

// Whether the database holds what the entry records: its event, or, for a disclosure, which has
// none, the disclosure.
export const heldEntry: HeldEntryFunction = async (storage, entry) => {
  const { personId, disclosure } = entry;
  if (disclosure !== undefined) {
    return disclosureHeld(await storage.recipients.disclosures(personId), disclosure);
  }
  const held = await storage.eventStore.readOne({
    aggregateType: BOUNDA_AGGREGATE,
    aggregateId: personId,
    eventId: entry.eventId,
  });
  return held !== null;
};

export interface AppliesNowFunction {
  (
    storage: AppliedStorage,
    entry: ForgetLedgerEntry,
    rules: ReconciliationRules,
    now: Date,
  ): Promise<boolean>;
}

// Whether a reconciliation reading the entry now would apply anything of it, decided by the checks
// each kind's is applied again with, whether or not the database holds it.
export const appliesNow: AppliesNowFunction = async (storage, entry, rules, now) => {
  const { personId, disclosure, redaction, restriction } = entry;
  if (disclosure !== undefined) {
    const { events } = await storage.eventStore.load({
      aggregateType: BOUNDA_AGGREGATE,
      aggregateId: personId,
    });
    return !forgottenSince(events, { forgottenAt: entry.forgottenAt, disclosure });
  }
  if (redaction !== undefined) {
    return redactionSeals({
      eventStore: storage.eventStore,
      keys: storage.personalKeys,
      aggregates: rules.aggregates,
      processes: rules.processes,
      personId,
      targets: redaction.events,
    });
  }
  if (restriction !== undefined) return restrictionDue(storage, { ...entry, restriction });
  const coverage = coverageOf(entry, rules.categories);
  if (coverage === null) return false;
  const retentionDue = appRetentionDue({
    categories: rules.categories,
    batchSize: rules.batchSize,
    checkpoints: storage.checkpointStore,
  });
  const due = dueKeysOf({ entry, coverage, retentionDue, clock: { now: () => now } });
  return (await due(storage)) !== null;
};

// Whether the next reconciliation of the database leaves the entry as it is, and no restore count
// reads it: the database holds what it records, or, for a disclosure, the forgetting since that
// removed it. An intention whose commit the database lacks may never have happened: it is left as
// is when the reconciliation would apply nothing of it, and the database stands where it was
// written or further.
const leftAsIs = async (
  storage: AppliedStorage,
  entry: ForgetLedgerEntry,
  stand: () => Promise<DatabaseStand>,
  rules: ReconciliationRules,
  now: Date,
): Promise<boolean> => {
  if (await heldEntry(storage, entry)) return true;
  if (entry.disclosure === undefined) {
    if (entry.committed !== false) return false;
    if (entry.reached !== undefined && standsShortOf(await stand(), entry.reached)) return false;
  }
  return !(await appliesNow(storage, entry, rules, now));
};

export interface StrandedEntriesArgs {
  // `null` for a database without Bounda's tables, which has applied none.
  readonly storage: AppliedStorage | null;
  // Asked once a database holds Bounda's tables.
  readonly rules: () => ReconciliationRules;
  readonly now: Date;
  // The ledger walked, past `after` and before `until`.
  readonly ledger: Pick<ForgetLedger, "read">;
  // The ledger the configuration names, which the database's reconciliation reads from `readFrom`
  // on; `null` when `ledger` is that one.
  readonly named: Pick<ForgetLedger, "read"> | null;
  readonly readFrom: string;
  readonly after?: ForgetLedgerPosition | undefined;
  readonly until?: string | undefined;
  readonly limit: number;
  readonly pageSize?: number;
}

export interface StrandedEntriesFunction {
  (args: StrandedEntriesArgs): Promise<readonly ForgetLedgerEntry[]>;
}

// The entries, up to `limit`, that the database lacks, that something would still apply, and that
// no app of the tenant reads: in the ledger the configuration names, those before where its
// reconciliation reads; in another, those it lacks or holds only before there. A forgetting for
// inactivity is the retention's, which decides it again on its own. A database without Bounda's
// tables lacks every one, and an app applies there what it applies once it creates them.
export const strandedEntries: StrandedEntriesFunction = async ({
  storage,
  rules,
  now,
  ledger,
  named,
  readFrom,
  after: from,
  until: asked,
  limit,
  pageSize = FORGET_LEDGER_PAGE,
}) => {
  const until = named === null && (asked === undefined || readFrom < asked) ? readFrom : asked;
  const found: ForgetLedgerEntry[] = [];
  let after = from;
  for (;;) {
    const page = await ledger.read({ ...(after === undefined ? {} : { after }), limit: pageSize });
    for (const entry of page) {
      if (until !== undefined && entry.forgottenAt >= until) return found;
      // Only a forgetting is for inactivity.
      if (entry.reason === "retention") continue;
      if (storage !== null) {
        if (await heldEntry(storage, entry)) continue;
        if (!(await appliesNow(storage, entry, rules(), now))) continue;
      }
      if (named !== null && entry.forgottenAt >= readFrom) {
        if (await holds(named, entry, pageSize)) continue;
      }
      found.push(entry);
      if (found.length >= limit) return found;
    }
    if (page.length < pageSize) return found;
    after = page.at(-1) ?? after;
  }
};

// Where a prune stops short of `keepFor`: at the oldest entry the database has yet to apply, and
// from when its reconciliation reads the ledger its configuration names.
interface Unapplied {
  readonly before: string;
  readonly readFrom: string;
}

interface AppliedBefore {
  // The oldest entry's time, `null` when none is older than `keepFor`.
  readonly oldest: string | null;
  readonly cutoff: string;
  readonly unapplied: Unapplied | null;
  readonly stranded: boolean;
}

export interface ReadFromOfFunction {
  (cursor: number): string;
}

// From when a reconciliation of a database whose cursor is `cursor` reads the ledger: before 1970
// for one that read nothing yet.
export const readFromOf: ReadFromOfFunction = (cursor) =>
  new Date(cursor - FORGET_LEDGER_REREAD_MS).toISOString();

// How far the ledger can be pruned: the entries older than `keepFor` the database can no longer
// need, those its reconciliation will not read again and those it applied. A copy restored brought
// its own cursor back, so what it lacks stays until a start applies it. In a ledger the database
// does not follow, whether an entry kept is stranded is told in the same look, before anything goes.
const appliedBefore = async ({
  ledger,
  forgotten,
  withStorage,
  rules,
  keepForMs,
  now,
  followed,
  named,
  pageSize = FORGET_LEDGER_PAGE,
}: PruneAsAppliedArgs): Promise<AppliedBefore> => {
  const cutoff = new Date(now.getTime() - keepForMs).toISOString();
  const [oldest] = await ledger.read({ limit: 1 });
  if (oldest === undefined || oldest.forgottenAt >= cutoff) {
    return { oldest: null, cutoff, unapplied: null, stranded: false };
  }
  const nothing = { unapplied: null, stranded: false };
  // A forgotten tenant's database may be gone already, or open under keys destroyed with it.
  const found =
    (await ledger.fence.read()).state === "forgotten" || (await forgotten())
      ? nothing
      : await withStorage(async (storage) => {
          if (storage !== null && (await storage.fence.read()).state === "forgotten") {
            return nothing;
          }
          const unapplied =
            storage === null
              ? { before: oldest.forgottenAt, readFrom: readFromOf(0) }
              : await oldestUnapplied(storage, { ledger, rules, now, followed, cutoff, pageSize });
          if (unapplied === null || followed || named === undefined) {
            return { unapplied, stranded: false };
          }
          const stranded = await named(
            async (own) =>
              (
                await strandedEntries({
                  storage,
                  rules,
                  now,
                  ledger,
                  named: own,
                  readFrom: unapplied.readFrom,
                  after: { forgottenAt: unapplied.before, eventId: "" },
                  until: cutoff,
                  limit: 1,
                  pageSize,
                })
              ).length > 0,
          );
          return { unapplied, stranded };
        });
  return { oldest: oldest.forgottenAt, cutoff, ...found };
};

interface OldestUnappliedArgs {
  readonly ledger: Pick<ForgetLedger, "read">;
  readonly rules: () => ReconciliationRules;
  readonly now: Date;
  readonly followed: boolean;
  readonly cutoff: string;
  readonly pageSize: number;
}

// The oldest entry before `cutoff` the database has yet to apply, read from where its
// reconciliation reads when it follows the ledger, else from the oldest.
const oldestUnapplied = async (
  storage: AppliedStorage,
  { ledger, rules, now, followed, cutoff, pageSize }: OldestUnappliedArgs,
): Promise<Unapplied | null> => {
  const readFrom = readFromOf(await storage.checkpointStore.get(FORGET_LEDGER_CURSOR));
  const applied = rules();
  let after: ForgetLedgerPosition | undefined = followed
    ? { forgottenAt: readFrom, eventId: "" }
    : undefined;
  for (;;) {
    const page = await ledger.read({ ...(after === undefined ? {} : { after }), limit: pageSize });
    // Read after the page, as the reconciliation reads it.
    let read: Promise<DatabaseStand> | undefined;
    const stand = () => {
      read ??= standOf(storage);
      return read;
    };
    for (const entry of page) {
      if (entry.forgottenAt >= cutoff) return null;
      if (!(await leftAsIs(storage, entry, stand, applied, now))) {
        return { before: entry.forgottenAt, readFrom };
      }
    }
    if (page.length < pageSize) return null;
    after = page.at(-1) ?? after;
  }
};

const removeApplied = async (
  ledger: Required<Pick<ForgetLedger, "prune">>,
  { oldest, cutoff, unapplied }: AppliedBefore,
): Promise<PrunedAsApplied> => {
  const before = unapplied?.before ?? cutoff;
  if (oldest !== null && before > oldest) await ledger.prune({ before });
  return { before, unapplied: unapplied !== null };
};

// Removes the entries older than `keepFor` the database can no longer need.
export const pruneAsApplied: PruneAsAppliedFunction = async (args) =>
  removeApplied(args.ledger, await appliedBefore(args));

export interface HoldsFunction {
  (
    ledger: Pick<ForgetLedger, "read">,
    entry: ForgetLedgerEntry,
    pageSize?: number,
  ): Promise<boolean>;
}

// Whether the ledger holds an entry at the time and of the id of `entry`.
export const holds: HoldsFunction = async (
  ledger,
  { forgottenAt, eventId },
  pageSize = FORGET_LEDGER_PAGE,
) => {
  let after: ForgetLedgerPosition = { forgottenAt, eventId: "" };
  for (;;) {
    const page = await ledger.read({ after, limit: pageSize });
    for (const entry of page) {
      if (entry.forgottenAt !== forgottenAt) return false;
      if (entry.eventId === eventId) return true;
    }
    if (page.length < pageSize) return false;
    after = page.at(-1) ?? after;
  }
};

export interface PruneTenantForgetLedgerArgs {
  /**
   * The project's configuration for the tenant, as `loadProject` resolves it.
   */
  readonly config: Config;
  /**
   * The project's registry, as `loadProject` gives it: what decides, as the app's reconciliation
   * does, whether an intention whose commit never happened still applies.
   */
  readonly registry: Registry;
  /**
   * The environment the forget ledger, the key wrapper and the tenant key store read, such as
   * `process.env`. Defaults to none.
   */
  readonly env?: AppEnv;
  /**
   * The tenant whose entries to prune. Defaults to `DEFAULT_TENANT`.
   */
  readonly tenant?: string;
  /**
   * The forget ledger's store to prune the tenant's entries in, as `listForgetLedgerTenants`
   * gives it in `stores`: one the configuration no longer names, which no app of the tenant reads.
   * Defaults to the one the configuration names; a store given is that one only as `stores` tells
   * it, an adapter of the same kind with the same options or the same definition.
   */
  readonly store?: ForgetLedgerSource;
  /**
   * Defaults to the current time.
   */
  readonly now?: Date;
}

export interface PrunedTenantForgetLedger {
  readonly tenant: string;
  /**
   * The store holds no entry of the tenant older than this any more: `keepFor` before `now`, or,
   * when `unapplied`, the time of the oldest entry the tenant's database has yet to apply.
   */
  readonly before: string;
  /**
   * Whether entries older than `keepFor` are kept because the tenant's database has not applied
   * them, as a copy restored while the app was stopped has not: an app of the tenant applies them
   * at its start, after which they go, unless `stranded`.
   */
  readonly unapplied: boolean;
  /**
   * Whether the store pruned is the one the configuration names. In another, which no app of the
   * tenant reads, an entry goes only once the database holds what it records or nothing can apply
   * it, whatever the database has read of its own ledger.
   */
  readonly named: boolean;
  /**
   * Whether, in a store the configuration does not name, `unapplied` kept an entry something
   * would still apply that no app of the tenant reads: the ledger the configuration names lacks
   * it, or holds it from before what the database's reconciliation reads again. It stays unapplied
   * until applied again by hand, as `listStrandedForgetLedgerEntries` lists it and `applyAgain`
   * applies it.
   */
  readonly stranded: boolean;
}

export interface PruneTenantForgetLedgerFunction {
  (args: PruneTenantForgetLedgerArgs): Promise<PrunedTenantForgetLedger>;
}

export interface RefusedFunction {
  (message: string): ConfigurationError;
}

export const refused: RefusedFunction = (message) => runtimeText(new ConfigurationError(message));

export interface PrunableArgs {
  readonly config: Config;
  readonly env: AppEnv;
  readonly tenant: string;
  // Opened in place of the store the configuration names.
  readonly store?: ForgetLedgerSource | undefined;
}

export interface Prunable {
  readonly ledger: ForgetLedger;
  readonly prune: NonNullable<ForgetLedger["prune"]>;
  readonly keepForMs: number;
  readonly resolved: ResolvedConfig;
  readonly source: ForgetLedgerSource;
  // The store the configuration names.
  readonly named: ForgetLedgerSource;
}

export interface PrunableFunction {
  (args: PrunableArgs): Promise<Prunable>;
}

// The ledger the configuration names for the tenant, or the store given, with its `keepFor`,
// refused when there is nothing for an operator to prune.
export const prunable: PrunableFunction = async ({ config, env, tenant, store }) => {
  const resolved = resolveConfig(config);
  const ledgerConfig = resolved.runtime.personalData.forgetLedger;
  if (ledgerConfig === null) {
    throw refused("Pruning the forget ledger needs runtime.personalData.forgetLedger");
  }
  const { keepForMs } = ledgerConfig;
  if (keepForMs === null) {
    throw refused(
      "Pruning the forget ledger needs runtime.personalData.forgetLedger.keepFor: without it, entries are kept until their tenant is forgotten",
    );
  }
  const source = store ?? ledgerConfig.store;
  const ledger = await openForgetLedger({
    source,
    storage: resolved.storage,
    env,
    tenant,
    keepForMs,
  });
  const { prune } = ledger;
  if (prune === undefined) {
    await ledger.close?.();
    throw refused(
      "The forget ledger expires its entries on its own, as Workers KV and a Durable Object's do: there is nothing to prune; for KV keys written before keepFor was set, run bounda forget-ledger expire",
    );
  }
  return { ledger, prune, keepForMs, resolved, source, named: ledgerConfig.store };
};

/**
 * Prunes a tenant's forget ledger past `keepFor` with no app of the tenant running: what
 * `bounda forget-ledger prune` runs, for a tenant whose app does not run to prune it in its
 * periodic reconciliation. It removes only what the tenant's database no longer needs: an entry
 * older than `keepFor` stays until the database has applied it, or, for an intention whose commit
 * never happened, until nothing can apply it, as the app's reconciliation decides with the
 * registry, so a copy restored while the app was stopped is forgotten again at the next start.
 * Given a `store` the configuration no longer names, it prunes the tenant's entries there, keeping
 * each one the database does not hold that something could still apply, and tells in `stranded`
 * whether one it keeps is read by no app. Safe beside running instances of the tenant.
 * It opens the tenant's database as `migrateTables` does, through the tenant's keys, only when an
 * entry older than `keepFor` is there; a tenant its ledger or its tenant key store knows forgotten
 * it prunes past `keepFor` alone, without opening its database. Rejects with `ConfigurationError`
 * without a forget ledger or `keepFor`, for a store that expires its entries on its own, for a
 * storage only its host opens, and for a registry the app refuses at its start, once it opens the
 * database. Given another `store` than the one the configuration names, as their ledgers'
 * `storeId` tells them apart, it rejects, pruning nothing, when the ledger the configuration names
 * cannot be opened, or read once it keeps an entry.
 */
export const pruneTenantForgetLedger: PruneTenantForgetLedgerFunction = async ({
  config,
  registry,
  env = {},
  tenant: asked,
  store,
  now = new Date(),
}) => {
  const tenant = tenantIdOf(asked);
  const opened = await prunable({ config, env, tenant, store });
  const { ledger, prune, keepForMs, resolved } = opened;
  const { storage } = resolved;
  // The ledger the configuration names, when another is pruned: opened once, when first needed.
  let named: Promise<ForgetLedger> | undefined;
  const namedLedger = (): Promise<ForgetLedger> => {
    named ??= openForgetLedger({ source: opened.named, storage, env, tenant, keepForMs });
    return named;
  };
  try {
    if (!isAdapter(storage)) {
      throw refused(
        "The storage is opened only by its host, as a Durable Object's is: its app prunes the forget ledger",
      );
    }
    // The same store, though given by another definition, as their ledgers tell.
    const followed =
      storeOf(opened.source) === storeOf(opened.named) ||
      physicalStoreOf(ledger, opened.source) === physicalStoreOf(await namedLedger(), opened.named);
    let rules: ReconciliationRules | undefined;
    const pruning = {
      read: ledger.read.bind(ledger),
      fence: ledger.fence,
      prune: prune.bind(ledger),
    };
    // Told before anything goes, so a ledger the configuration names that cannot be read prunes
    // nothing.
    const applied = await appliedBefore({
      ledger: pruning,
      keepForMs,
      now,
      followed,
      named: async (work) => work(await namedLedger()),
      rules: () => {
        rules ??= reconciliationRulesOf({ registry, config: resolved });
        return rules;
      },
      forgotten: async () => {
        const { tenantKeys } = keySourcesOf({
          storage,
          personalData: resolved.runtime.personalData,
        });
        if (tenantKeys === null) return false;
        const keys = await openTenantKeyStore({ source: tenantKeys, storage, env });
        try {
          return ((await keys.get(tenant))?.forgotten ?? null) !== null;
        } finally {
          await keys.close?.();
        }
      },
      withStorage: (work) => withTenantStorage({ config, env, tenant, work }),
    });
    return {
      tenant,
      ...(await removeApplied(pruning, applied)),
      named: followed,
      stranded: applied.stranded,
    };
  } finally {
    try {
      await ledger.close?.();
    } finally {
      const own = await named?.catch(() => undefined);
      await own?.close?.();
    }
  }
};

export interface WithTenantStorageArgs<T> {
  readonly config: Config;
  readonly env: AppEnv;
  readonly tenant: string;
  // `null` for a database that holds no table yet.
  readonly work: (storage: AppliedStorage | null) => Promise<T>;
}

export interface WithTenantStorageFunction {
  <T>(args: WithTenantStorageArgs<T>): Promise<T>;
}

// The tenant's database, opened as `migrateTables` opens it, through the tenant's keys, and closed
// after `work`; a database without Bounda's tables has applied nothing, and stays without them.
export const withTenantStorage: WithTenantStorageFunction = ({ config, env, tenant, work }) =>
  withEncryptedFiles({
    config,
    env,
    tenant,
    work: async (keyed) => {
      const adapter = resolveConfig(keyed).storage as Adapter;
      const versions = await adapter.schemaVersions();
      if (versions.some(({ scope, version }) => scope === "storage" && version === 0)) {
        return work(null);
      }
      const created = await adapter.createStorage();
      try {
        return await work(created);
      } finally {
        await created.close();
      }
    },
  });
