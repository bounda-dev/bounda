import type {
  ForgottenRecipient,
  ForgottenRecipientStatus,
} from "../../adapter/storage/recipient-store.ts";
import type { PersonRecipient } from "../../modules/recipient.ts";

export interface ForgottenFromArgs {
  // The person's recipients as `recipientsOf` listed them just before the forgetting, and just
  // after it, in the same transaction.
  readonly before: readonly PersonRecipient[];
  readonly after: readonly PersonRecipient[];
}

export interface ForgottenFromFunction {
  (args: ForgottenFromArgs): readonly ForgottenRecipient[];
}

const COUNTED: ReadonlySet<PersonRecipient["status"]> = new Set<ForgottenRecipientStatus>([
  "disclosed",
  "presumed",
]);

const keyOf = ({ port, name, kind, country, transfer, status }: PersonRecipient): string =>
  JSON.stringify([port, name, kind, country, transfer?.safeguard ?? null, status]);

/**
 * What a forgetting took off the person's list of recipients, as counts of one: each category it
 * was listed with under an identity and status and is no more, and the identity and status
 * themselves, with no category, once the person is listed with them no more. A recipient only
 * declared received nothing, and is not counted.
 */
export const forgottenFrom: ForgottenFromFunction = ({ before, after }) => {
  const left = new Map(after.map((recipient) => [keyOf(recipient), recipient]));
  const counted: ForgottenRecipient[] = [];
  for (const recipient of before) {
    if (!COUNTED.has(recipient.status)) continue;
    const kept = left.get(keyOf(recipient));
    const still = new Set(kept?.categories.map(({ name }) => name));
    const count = (category: string | null): ForgottenRecipient => ({
      port: recipient.port,
      recipient: recipient.name,
      kind: recipient.kind,
      country: recipient.country,
      safeguard: recipient.transfer?.safeguard ?? null,
      status: recipient.status as ForgottenRecipientStatus,
      category,
      persons: 1,
    });
    for (const { name } of recipient.categories) {
      if (!still.has(name)) counted.push(count(name));
    }
    if (kept === undefined) counted.push(count(null));
  }
  return counted;
};
