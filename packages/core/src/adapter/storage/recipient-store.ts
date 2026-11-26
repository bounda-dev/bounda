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
  /**
   * How far the runtime has told it, presumed, of what the person's streams recorded before it
   * was declared: the forgettings, restrictions and redactions it could not have been told of.
   */
  readonly caughtUpThrough: number;
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
 * How a forgotten person's data stood with a recipient: recorded as disclosed to it, or presumed
 * to have gone to it before it was declared.
 */
export type ForgottenRecipientStatus = "disclosed" | "presumed";

/**
 * How many persons forgettings took off a recipient's list under one identity it had, its port,
 * name, kind, country and safeguard, and one status: those whose data of `category` it was listed
 * with, or, with `category` `null`, those it was listed with no more. A count, never whom, and no
 * time.
 */
export interface ForgottenRecipient {
  readonly port: string;
  readonly recipient: string;
  readonly kind: string;
  readonly country: string;
  readonly safeguard: string | null;
  readonly status: ForgottenRecipientStatus;
  readonly category: string | null;
  readonly persons: number;
}

/**
 * Which personal data went to which recipient, which recipients the app declared, and how many
 * forgotten persons each was listed with. Rows hold ids, names, times and counts alone, never a
 * value.
 *
 * `disclose` records disclosures at `at`: a new one with both times at it, a known one with its
 * last moved forward, never back; it resolves to those it had not recorded before. `forget` removes
 * the person's disclosures of those categories, of every category when `null`. `declare` records
 * each port it has not seen with `presumedThrough` at `position`, updates the categories of those
 * it has, and resolves to every port declared; `presumeThrough` moves every port's `presumedThrough` up to
 * `position`, never down, for a database whose disclosures since may have been lost. `rename` moves
 * what the store holds under the port `from` to the port `to`, a disclosure held under both kept
 * once, from the first time to the last, a declaration held under both presumed through the
 * later position, and counts held under both summed. `caughtUp` moves a port's `caughtUpThrough`
 * up to `position`, never down. `countForgotten` adds each count's `persons` to what the store
 * holds for its identity, status and category, from none; `forgottenCounts` resolves to every count
 * held, in no order.
 */
export interface RecipientStore {
  disclose(disclosures: readonly Disclosure[], at: string): Promise<readonly Disclosure[]>;
  disclosures(person: string): Promise<readonly StoredDisclosure[]>;
  /**
   * `disclosures` of each of `persons` at once, by person; a person without any is left out.
   */
  disclosuresOfMany(
    persons: readonly string[],
  ): Promise<ReadonlyMap<string, readonly StoredDisclosure[]>>;
  forget(person: string, categories: readonly string[] | null): Promise<void>;
  declare(
    ports: readonly RecipientPort[],
    position: number,
    at: string,
  ): Promise<readonly DeclaredRecipient[]>;
  declared(): Promise<readonly DeclaredRecipient[]>;
  presumeThrough(position: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  caughtUp(port: string, position: number): Promise<void>;
  summary(): Promise<readonly RecipientSummary[]>;
  countForgotten(counts: readonly ForgottenRecipient[]): Promise<void>;
  forgottenCounts(): Promise<readonly ForgottenRecipient[]>;
  /**
   * Every category disclosed to each port, of any person, by port.
   */
  received(): Promise<ReadonlyMap<string, readonly string[]>>;
  /**
   * The persons disclosed to the port, in order of their id, past `after`, at most `limit`.
   */
  personsOf(args: PersonsOfArgs): Promise<readonly string[]>;
}

/**
 * Which persons `personsOf` lists: those disclosed to `port` whose id comes after `after`, from
 * the first when `null`, at most `limit`.
 */
export interface PersonsOfArgs {
  readonly port: string;
  readonly after: string | null;
  readonly limit: number;
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

export interface ForgottenKeyFunction {
  (counted: ForgottenRecipient): string;
}

export const forgottenKey: ForgottenKeyFunction = ({
  port,
  recipient,
  kind,
  country,
  safeguard,
  status,
  category,
}) => JSON.stringify([port, recipient, kind, country, safeguard, status, category]);
