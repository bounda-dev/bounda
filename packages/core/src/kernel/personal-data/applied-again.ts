import type { Storage } from "../../adapter/adapter.ts";
import type { ForgetLedger, ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import { heldEntry, holds, readFromOf } from "./ledger-prune.ts";
import {
  type AppliedEntryKind,
  type ApplyEntryAgainArgs,
  applyEntryAgain,
  FORGET_LEDGER_CURSOR,
} from "./reconciliation.ts";
import { checkPersonId } from "./transact.ts";

/**
 * What applying a forget ledger's entry again did, in the order the entries were given.
 */
export interface AppliedAgain {
  readonly personId: string;
  readonly eventId: string;
  /**
   * What the entry records: a forgetting, a change of restrictions, a redaction or a disclosure.
   */
  readonly kind: AppliedEntryKind;
  /**
   * `applied` when it was applied again now. `held` when the database holds it already.
   * `reconciled` when the forget ledger the configuration names holds it where the reconciliation
   * reads it, which applies it, and counts the restore its loss tells. `inapplicable` when nothing
   * of it applies to the database as it stands, as the reconciliation decides it: the person holds
   * no key the forgetting covers and names, or the retention would not forget them now; a later
   * change of the person's restrictions is held, or the restrictions held are already what it left;
   * no field the redaction names holds a value the person's keys open; the disclosure's category
   * was forgotten since.
   */
  readonly outcome: "applied" | "held" | "reconciled" | "inapplicable";
}

export interface ApplyAgainOptions {
  /**
   * Who applies them again, named in the metadata of each event appended and in its log line, as
   * `as` names who acts: `applyAgain` lives on the app, not on a client.
   */
  readonly actor?: string;
}

export interface ApplyEntriesAgainArgs
  extends Omit<ApplyEntryAgainArgs, "entry" | "record" | "actor" | "storage"> {
  readonly storage: ApplyEntryAgainArgs["storage"] & Pick<Storage, "checkpointStore">;
  // The ledger the configuration names, `null` without one.
  readonly ledger: Pick<ForgetLedger, "read"> | null;
  readonly entries: readonly ForgetLedgerEntry[];
  readonly actor: string | undefined;
  // Told each person forgotten again.
  readonly forgotten: (personId: string) => void;
}

export interface ApplyEntriesAgainFunction {
  (args: ApplyEntriesAgainArgs): Promise<readonly AppliedAgain[]>;
}

const kindOf = (entry: ForgetLedgerEntry): AppliedEntryKind => {
  if (entry.redaction !== undefined) return "redaction";
  if (entry.restriction !== undefined) return "restriction";
  if (entry.disclosure !== undefined) return "disclosure";
  return "forgetting";
};

// Each entry in turn, as the reconciliation applies it, recorded in the ledger first once found
// due. One the ledger holds where the reconciliation reads it is left to the reconciliation: what
// it applies of an entry the database lost tells it a restore.
export const applyEntriesAgain: ApplyEntriesAgainFunction = async ({
  ledger,
  entries,
  actor,
  forgotten,
  ...applying
}) => {
  for (const { personId } of entries) checkPersonId(personId, "applyAgain");
  const { storage } = applying;
  const done: AppliedAgain[] = [];
  for (const entry of entries) {
    const outcome = async (): Promise<AppliedAgain["outcome"]> => {
      if (await heldEntry(storage, entry)) return "held";
      if (ledger !== null) {
        const readFrom = readFromOf(await storage.checkpointStore.get(FORGET_LEDGER_CURSOR));
        if (entry.forgottenAt >= readFrom && (await holds(ledger, entry))) return "reconciled";
      }
      const applied = await applyEntryAgain({ ...applying, entry, record: true, actor });
      if (applied === "forgetting") forgotten(entry.personId);
      if (applied !== null) return "applied";
      return (await heldEntry(storage, entry)) ? "held" : "inapplicable";
    };
    done.push({
      personId: entry.personId,
      eventId: entry.eventId,
      kind: kindOf(entry),
      outcome: await outcome(),
    });
  }
  return done;
};
