/**
 * Personal data of one category of a person that a port handed to its recipient, under the
 * recipient's identity as the port declared it then.
 */
export interface Disclosure {
  readonly person: string;
  /**
   * `"<aggregate or read model>.<port>"`.
   */
  readonly port: string;
  readonly recipient: string;
  readonly kind: string;
  readonly country: string;
  readonly safeguard: string | null;
  readonly category: string;
}

/**
 * A disclosure as the store keeps it: when it was first and last recorded, as ISO timestamps.
 */
export interface StoredDisclosure extends Disclosure {
  readonly firstAt: string;
  readonly lastAt: string;
}

/**
 * A port the app declared a recipient of, as the store first saw it: data of persons named by
 * events at or before `presumedThrough` may have gone to it before anything was recorded.
 */
export interface DeclaredRecipient {
  readonly port: string;
  /**
   * The categories its declaration names now.
   */
  readonly categories: readonly string[];
  readonly presumedThrough: number;
  readonly declaredAt: string;
}

/**
 * A port as the app declares its recipient when it starts.
 */
export interface RecipientPort {
  readonly port: string;
  readonly categories: readonly string[];
}

/**
 * How many persons a port's recipient holds disclosures of.
 */
export interface RecipientSummary {
  readonly port: string;
  readonly persons: number;
}

/**
 * Which personal data went to which recipient, and which recipients the app declared. Rows hold
 * ids, names and times alone, never a value.
 *
 * `disclose` records disclosures at `at`: a new one with both times at it, a known one with its
 * last moved forward, never back; it resolves to those it had not recorded before. `forget` removes
 * the person's disclosures of those categories, of every category when `null`. `declare` records
 * each port it has not seen with `presumedThrough` at `position`, updates the categories of those
 * it has, and resolves to every port declared; `presumeThrough` moves every port's `presumedThrough` up to
 * `position`, never down, for a database whose disclosures since may have been lost.
 */
export interface RecipientStore {
  disclose(disclosures: readonly Disclosure[], at: string): Promise<readonly Disclosure[]>;
  disclosures(person: string): Promise<readonly StoredDisclosure[]>;
  forget(person: string, categories: readonly string[] | null): Promise<void>;
  declare(
    ports: readonly RecipientPort[],
    position: number,
    at: string,
  ): Promise<readonly DeclaredRecipient[]>;
  declared(): Promise<readonly DeclaredRecipient[]>;
  presumeThrough(position: number): Promise<void>;
  summary(): Promise<readonly RecipientSummary[]>;
}

export interface DisclosureKeyFunction {
  (disclosure: Disclosure): string;
}

/**
 * What tells one disclosure from another: the person, the port, the recipient's name and the
 * category.
 */
export const disclosureKey: DisclosureKeyFunction = ({ person, port, recipient, category }) =>
  JSON.stringify([person, port, recipient, category]);
