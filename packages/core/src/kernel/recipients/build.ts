import { ConfigurationError } from "../../contracts/errors.ts";
import {
  ADEQUATE_COUNTRIES,
  COUNTRY_CODES,
  type CountryCode,
  EEA_COUNTRIES,
  PARTIAL_ADEQUACY,
  type PartialAdequacy,
  RECIPIENT_HANDLERS,
  RECIPIENT_KINDS,
  type RecipientHandlerName,
  type RecipientKind,
  type RecipientModule,
  TRANSFER_SAFEGUARDS,
  type TransferSafeguard,
} from "../../modules/recipient.ts";
import type { Registry } from "../../modules/registry.ts";
import type { PersonalCategories } from "../personal-data/categories.ts";
import type { ModulePorts } from "../ports/ports.ts";

/**
 * A recipient as the runtime holds it, its declaration checked.
 */
export interface RecipientRuntime {
  /**
   * `"<aggregate or read model>.<port>"`.
   */
  readonly port: string;
  readonly owner: string;
  /**
   * The port's name, under which its handlers receive it.
   */
  readonly name: string;
  readonly recipient: string;
  readonly kind: RecipientKind;
  readonly country: CountryCode;
  readonly safeguard: TransferSafeguard | null;
  readonly categories: readonly string[];
  readonly formerly: readonly string[];
  readonly handlers: Readonly<Record<RecipientHandlerName, (args: never) => unknown>>;
  /**
   * The port's implementation, read when a handler runs: a test app's port left out throws only
   * then.
   */
  readonly implementation: () => unknown;
}

export interface RecipientsRuntime {
  readonly all: readonly RecipientRuntime[];
  /**
   * By port, and by every key a port had before a rename.
   */
  readonly byPort: Readonly<Record<string, RecipientRuntime>>;
  /**
   * By owner, then by port name: the ports whose calls disclose what a run opened.
   */
  readonly byOwner: Readonly<Record<string, Readonly<Record<string, RecipientRuntime>>>>;
}

// The recipients of an app that declares none.
export const NO_RECIPIENTS: RecipientsRuntime = { all: [], byPort: {}, byOwner: {} };

export interface BuildRecipientsArgs {
  readonly registry: Registry;
  readonly categories: PersonalCategories;
  readonly ports: { readonly byAggregate: ModulePorts; readonly byReadModel: ModulePorts };
}

export interface BuildRecipientsFunction {
  (args: BuildRecipientsArgs): RecipientsRuntime;
}

const COUNTRIES: ReadonlySet<unknown> = new Set(COUNTRY_CODES);
const EEA: ReadonlySet<string> = new Set(EEA_COUNTRIES);
const ADEQUATE: ReadonlySet<string> = new Set(ADEQUATE_COUNTRIES);
const PARTIAL: ReadonlyMap<unknown, PartialAdequacy> = new Map(Object.entries(PARTIAL_ADEQUACY));
const PORT_KEY = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const listed = (values: readonly string[]): string =>
  values.map((value) => JSON.stringify(value)).join(", ");

export interface CheckRecipientTransferFunction {
  (port: string, recipient: Readonly<Record<string, unknown>>): void;
}

// Where the recipient is and what its transfer rests on, as the app checks it at boot and the
// record of processing before it names the transfer.
export const checkRecipientTransfer: CheckRecipientTransferFunction = (port, recipient) => {
  const fail = (message: string): never => {
    throw new ConfigurationError(`Port ${port}: ${message}`);
  };
  const { country, safeguard, adequacyScope } = recipient;
  if (!COUNTRIES.has(country)) {
    fail(`recipient.country ${JSON.stringify(country)} is not an ISO 3166-1 alpha-2 code`);
  }
  const inEea = EEA.has(country as string);
  if (inEea && safeguard !== undefined) {
    fail(`recipient.country ${country} is in the European Economic Area, so it takes no safeguard`);
  }
  if (!inEea && !TRANSFER_SAFEGUARDS.includes(safeguard as TransferSafeguard)) {
    fail(
      `recipient.country ${country} is outside the European Economic Area, so recipient.safeguard names what the transfer rests on: one of ${listed(TRANSFER_SAFEGUARDS)}`,
    );
  }
  if (safeguard === "adequacy" && !ADEQUATE.has(country as string)) {
    fail(
      `recipient.country ${country} has no adequacy decision of the European Commission, so the transfer rests on another safeguard: one of ${listed(TRANSFER_SAFEGUARDS.filter((known) => known !== "adequacy"))}`,
    );
  }
  const partial = PARTIAL.get(country);
  if (safeguard === "adequacy" && partial !== undefined && adequacyScope !== partial.scope) {
    fail(
      `recipient.country ${country} has an adequacy decision, ${partial.decision}, for ${partial.covers} alone${adequacyScope === undefined ? "" : `, and recipient.adequacyScope ${JSON.stringify(adequacyScope)} is not its scope`}: once you verified the recipient is ${partial.condition}, declare adequacyScope: ${JSON.stringify(partial.scope)} beside the safeguard, or rest the transfer on another safeguard: one of ${listed(TRANSFER_SAFEGUARDS.filter((known) => known !== "adequacy"))}`,
    );
  }
  if (adequacyScope !== undefined && (safeguard !== "adequacy" || partial === undefined)) {
    fail(
      safeguard === "adequacy"
        ? `recipient.adequacyScope ${JSON.stringify(adequacyScope)} names part of a partial adequacy decision, and the decision for ${country} covers every recipient there: remove it`
        : `recipient.adequacyScope ${JSON.stringify(adequacyScope)} names part of a partial adequacy decision, so it goes beside safeguard: "adequacy" alone: remove it`,
    );
  }
};

const checked = (
  port: string,
  module: RecipientModule,
  categories: PersonalCategories,
): Omit<RecipientRuntime, "port" | "owner" | "name" | "implementation"> => {
  const fail = (message: string): never => {
    throw new ConfigurationError(`Port ${port}: ${message}`);
  };
  const declared: unknown = module.recipient;
  if (!isRecord(declared)) fail("recipient must be an object: { name, kind, country, categories }");
  const recipient = declared as Readonly<Record<string, unknown>>;
  const { name, kind, country, safeguard, formerly } = recipient;
  if (typeof name !== "string" || name.trim() === "") {
    fail("recipient.name must name who receives the data");
  }
  if (!RECIPIENT_KINDS.includes(kind as RecipientKind)) {
    fail(`recipient.kind ${JSON.stringify(kind)} is none of ${listed(RECIPIENT_KINDS)}`);
  }
  checkRecipientTransfer(port, recipient);
  const inEea = EEA.has(country as string);
  const named = recipient.categories;
  if (!Array.isArray(named) || named.length === 0) {
    fail("recipient.categories must list the categories of personal data the port sends it");
  }
  const known: ReadonlySet<unknown> = new Set(categories.all.map((category) => category.name));
  for (const category of named as readonly unknown[]) {
    if (!known.has(category)) {
      fail(`recipient.categories names ${JSON.stringify(category)}, which the app does not have`);
    }
  }
  if (new Set(named as readonly string[]).size !== (named as readonly string[]).length) {
    fail("recipient.categories names a category twice");
  }
  if (
    formerly !== undefined &&
    (!Array.isArray(formerly) || formerly.some((key) => !PORT_KEY.test(String(key))))
  ) {
    fail(
      'recipient.formerly must list keys such as "customer.mailer", the port\'s before a rename',
    );
  }
  for (const handler of Object.keys(RECIPIENT_HANDLERS) as RecipientHandlerName[]) {
    if (typeof module[handler] !== "function") {
      fail(
        `it declares a recipient, so it exports ${handler}, which tells it of ${RECIPIENT_HANDLERS[handler]}`,
      );
    }
  }
  return {
    recipient: (name as string).trim(),
    kind: kind as RecipientKind,
    country: country as CountryCode,
    safeguard: inEea ? null : (safeguard as TransferSafeguard),
    categories: named as readonly string[],
    formerly: (formerly as readonly string[] | undefined) ?? [],
    handlers: Object.fromEntries(
      Object.keys(RECIPIENT_HANDLERS).map((handler) => [
        handler,
        module[handler as RecipientHandlerName],
      ]),
    ) as RecipientRuntime["handlers"],
  };
};

/**
 * Checks every recipient the registry declares. Throws `ConfigurationError` for a declaration
 * without a name, a kind, an ISO country, the safeguard a country outside the European Economic
 * Area takes, the `adequacyScope` a partial adequacy decision takes and only it, or categories the
 * app has; for a handler missing; for a port that declares one and
 * has no implementation; and for a former key that is a port now or that two ports claim.
 */
export const buildRecipients: BuildRecipientsFunction = ({ registry, categories, ports }) => {
  const all: RecipientRuntime[] = [];
  const owners = [
    ...Object.entries(registry.aggregates).map(
      ([owner, entry]) => [owner, entry, ports.byAggregate[owner] ?? {}] as const,
    ),
    ...Object.entries(registry.readModels).map(
      ([owner, entry]) => [owner, entry, ports.byReadModel[owner] ?? {}] as const,
    ),
  ];
  for (const [owner, entry, implementations] of owners) {
    for (const [name, module] of Object.entries(entry.recipients ?? {})) {
      const port = `${owner}.${name}`;
      if (entry.ports?.[name] === undefined) {
        throw new ConfigurationError(
          `Port ${port}: it declares a recipient and has no implementation in infrastructure/${name}/`,
        );
      }
      all.push({
        port,
        owner,
        name,
        ...checked(port, module, categories),
        implementation: () => implementations[name],
      });
    }
  }
  const byPort: Record<string, RecipientRuntime> = Object.fromEntries(
    all.map((recipient) => [recipient.port, recipient]),
  );
  const declaredPorts = new Set(
    owners.flatMap(([owner, entry]) =>
      Object.keys(entry.ports ?? {}).map((name) => `${owner}.${name}`),
    ),
  );
  for (const recipient of all) {
    for (const former of recipient.formerly) {
      if (declaredPorts.has(former)) {
        throw new ConfigurationError(
          `Port ${recipient.port}: recipient.formerly names ${former}, which is a port of the app`,
        );
      }
      const claimed = byPort[former];
      if (claimed !== undefined) {
        throw new ConfigurationError(
          `Port ${recipient.port}: recipient.formerly names ${former}, which is formerly ${claimed.port} too`,
        );
      }
      byPort[former] = recipient;
    }
  }
  const byOwner: Record<string, Record<string, RecipientRuntime>> = {};
  for (const recipient of all) {
    byOwner[recipient.owner] = { ...byOwner[recipient.owner], [recipient.name]: recipient };
  }
  return { all, byPort, byOwner };
};
