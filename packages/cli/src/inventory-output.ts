import {
  type CriminalOffenceData,
  type InventoryAutomatedDecision,
  type InventoryCategory,
  type InventoryHolder,
  type InventoryHolderKind,
  type InventoryRecord,
  type InventoryRecordName,
  type InventorySealing,
  type InventoryStore,
  type PersonalDataInventory,
  type PersonalDataSource,
  SPECIAL_CATEGORY_CONDITIONS,
  type SpecialCategoryData,
} from "@bounda-dev/core";

export interface FormatInventoryFunction {
  (inventory: PersonalDataInventory): string;
}

const KINDS: Readonly<Record<InventoryHolderKind, string>> = {
  event: "event",
  command: "command",
  "process-state": "process state",
  "read-model": "read model",
};

const STORES: Readonly<Record<InventoryStore, string>> = {
  "event-store": "event store",
  snapshots: "snapshots",
  "scheduled-commands": "scheduled commands",
  "dead-letters": "dead letters",
  "read-model": "read-model table",
};

const SEALING: Readonly<Record<InventorySealing, string>> = {
  sealed: "sealed under the person's key",
  "sealed-indexed": "sealed under the person's key, found by a blind index",
  clear: "in the clear, forgotten by the read model's projection",
};

const RECORDS: Readonly<Record<InventoryRecordName, { holds: string; kept: string }>> = {
  "personal-keys": {
    holds: "a key per person and category, wrapped under the tenant's key",
    kept: "until the category is forgotten",
  },
  persons: {
    holds: "each person's id, last activity and restriction",
    kept: "for as long as the database",
  },
  forgettings: {
    holds:
      "the runtime's events about each person (forgotten, restricted, lifted, redacted): ids and categories, never values",
    kept: "for good",
  },
  "remembered-answers": {
    holds:
      "the answer of each command dispatched with an idempotency key, sealed under its persons; an export holds one back from each when it names several (article 15(4))",
    kept: "until erased by a forgetting",
  },
  "dead-letters": {
    holds:
      "the payload of each command that gave up, and the error text of failed work, sealed under the persons it names and everyone whose data the work read; an export holds the text back from each when it is sealed under several (article 15(4))",
    kept: "for good once retried or discarded, unreadable once their person is forgotten",
  },
  "subscriber-failures": {
    holds:
      "the error text of each subscriber's last failure, sealed under the person its event names and everyone whose data its delivery read; an export holds it back from each when it is sealed under several (article 15(4))",
    kept: "until the subscriber's next failure replaces it, unreadable once their person is forgotten",
  },
  disclosures: {
    holds: "which categories of whose data went to each recipient, and when",
    kept: "for as long as the database",
  },
  "forget-ledger": {
    holds:
      "each forgetting's person, categories and reason, and each change of restrictions, redaction and disclosure with its ids and names, the recipient's included, outside the database",
    kept: "until the tenant is forgotten and every recipient of its data told",
  },
  "access-log": {
    holds: "every access to personal data, by ids, handed to app/audit.ts",
    kept: "as the app keeps it",
  },
};

const keptFor = (record: InventoryRecord): string => {
  if (record.keptFor === null) return RECORDS[record.name].kept;
  if (record.name === "dead-letters") {
    return `retried or discarded letters for ${record.keptFor}, longer while a person they hold data of is restricted and that data still opens, failed ones until resolved; unreadable once their person is forgotten`;
  }
  if (record.name === "subscriber-failures") {
    return `until the subscriber's next failure replaces it, or for ${record.keptFor} once the subscriber got past it or the app stopped running it, longer while a person its text is sealed under is restricted and it still opens; unreadable once their person is forgotten`;
  }
  if (record.name === "remembered-answers") {
    return `${record.keptFor}, or until erased by a forgetting`;
  }
  // The forget ledger's, the last record a setting bounds.
  return `${record.keptFor}, or until the tenant is forgotten and every recipient of its data told`;
};

const whose = (holder: InventoryHolder): string => {
  if (holder.person !== null) return `the person in ${holder.person}`;
  return holder.kind === "process-state" ? "the instance's id" : "the aggregate's id";
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

const basisOf = (basis: string | null): string => basis ?? "no basis declared";

const retentionOf = (retention: string | null): string =>
  retention === null ? "kept until forgotten" : `forgotten ${retention} after last activity`;

const sourceOf = (source: PersonalDataSource): string => {
  if (source === "data-subject") return "the person";
  if (source === "derived") return "derived by the app";
  return `${source.name} (${source.kind === "public" ? "public source" : "third party"})`;
};

const purposesOf = ({ purposes }: InventoryCategory): string =>
  purposes.length === 0 ? "no purpose declared" : purposes.join("; ");

const sourcesOf = ({ sources }: InventoryCategory): string =>
  sources.length === 0 ? "no source declared" : sources.map(sourceOf).join(", ");

const decisionOf = (decision: InventoryAutomatedDecision): string =>
  `${decision.profiling ? "profiling, " : ""}on ${decision.ground}, from ${decision.categories.join(", ")}`;

// The database, and where it keeps its data when its definition pins it.
const placed = (database: string, location: string | null): string =>
  location === null ? database : `${database}, ${location}`;

// A condition with its point of article 9(2), from (a) to (j) in the order the article gives them.
const conditionOf = ({ condition }: SpecialCategoryData): string =>
  `${condition} (article 9(2)(${String.fromCharCode(97 + SPECIAL_CATEGORY_CONDITIONS.indexOf(condition))}))`;

const specialOf = (special: SpecialCategoryData): string =>
  `${special.kinds.join(", ")}, on ${conditionOf(special)}`;

const criminalOf = ({ authority }: CriminalOffenceData): string =>
  `under ${authority} (article 10)`;

const processedForOf = ({ processedFor }: InventoryCategory): string =>
  processedFor.length === 0 ? "none" : processedFor.join(", ");

const exemptionsOf = ({ erasureExemptions }: InventoryCategory): string =>
  erasureExemptions.length === 0
    ? "none"
    : erasureExemptions
        .map(({ exemption, article }) => `${exemption} (article ${article})`)
        .join(", ");

// What of the categories a decision decides on holds special categories of data, which article
// 22(4) restricts.
const specialDecidedOn = (
  decision: InventoryAutomatedDecision,
  inventory: PersonalDataInventory,
): string =>
  inventory.categories
    .flatMap(({ name, special }) =>
      special === null || !decision.categories.includes(name)
        ? []
        : [`${name} (${specialOf(special)})`],
    )
    .join("; ");

const security = (inventory: PersonalDataInventory): readonly string[] => [
  `master key: ${inventory.security.masterKey ? "named by the configuration" : "none named"}`,
  `tenant key store: ${inventory.security.tenantKeys ? "apart from the database" : "none named"}`,
  `forget ledger: ${inventory.security.forgetLedger ? "a restored backup forgets again" : "none: a restored backup brings back whom it forgot after the copy"}`,
];

/**
 * The record as `bounda personal-data inventory` prints it in a terminal.
 */
export const formatInventory: FormatInventoryFunction = (inventory) => {
  const lines: string[] = ["Personal data inventory (GDPR article 30)", "", "Categories"];
  for (const category of inventory.categories) {
    lines.push(
      `  ${category.name}  ${basisOf(category.basis)}  ${retentionOf(category.retention)}  ${plural(category.fields, "field")}`,
      `    for: ${purposesOf(category)}`,
      `    from: ${sourcesOf(category)}`,
    );
    if (category.ports.length > 0) {
      lines.push(`    returned by: ${category.ports.join(", ")}`);
    }
    if (category.special !== null) {
      lines.push(`    special categories (article 9): ${specialOf(category.special)}`);
    }
    if (category.criminal !== null) {
      lines.push(`    criminal data: ${criminalOf(category.criminal)}`);
    }
    if (category.processedFor.length > 0) {
      lines.push(`    processed for: ${processedForOf(category)}`);
    }
    if (category.erasureExemptions.length > 0) {
      lines.push(`    kept past erasure: ${exemptionsOf(category)}`);
    }
  }
  lines.push("", "Automated decisions");
  if (inventory.automatedDecisions.length === 0) lines.push("  none declared");
  for (const decision of inventory.automatedDecisions) {
    const special = specialDecidedOn(decision, inventory);
    lines.push(
      `  ${decision.name}  ${decisionOf(decision)}`,
      `    logic: ${decision.logic}`,
      `    significance: ${decision.significance}`,
      `    consequences: ${decision.consequences}`,
      ...(special === "" ? [] : [`    special categories (article 22(4)): ${special}`]),
      ...(decision.measures === undefined ? [] : [`    measures: ${decision.measures}`]),
    );
  }
  lines.push("", "Personal data");
  if (inventory.holders.length === 0) lines.push("  none marked");
  for (const holder of inventory.holders) {
    lines.push(`  ${KINDS[holder.kind]} ${holder.name}, of ${whose(holder)}`);
    for (const field of holder.fields) {
      lines.push(`    ${field.name}  ${field.category}  ${SEALING[field.sealing]}`);
    }
    lines.push(
      `    kept in: ${holder.stores.map((store) => STORES[store]).join(", ")} (${placed(holder.database, holder.location)})`,
    );
  }
  lines.push("", "Recipients");
  if (inventory.recipients.length === 0) lines.push("  none declared");
  for (const recipient of inventory.recipients) {
    lines.push(
      `  ${recipient.port}  ${recipient.name}, ${recipient.kind} in ${recipient.country}${recipient.safeguard === null ? "" : ` under ${recipient.safeguard}`}: ${recipient.categories.join(", ")}`,
    );
  }
  lines.push("", "Kept by the runtime");
  for (const record of inventory.records) {
    lines.push(
      `  ${record.name}  ${RECORDS[record.name].holds}; ${keptFor(record)} (${placed(record.where, record.location)})`,
    );
  }
  lines.push("", "Keys", ...security(inventory).map((text) => `  ${text}`));
  if (inventory.notPersonal.length > 0) {
    lines.push("", "Declared not personal");
    for (const field of inventory.notPersonal) {
      lines.push(`  ${KINDS[field.kind]} ${field.name}: ${field.field}`);
    }
  }
  lines.push("");
  if (inventory.findings.length === 0) {
    lines.push("Complete: every field is classified");
  } else {
    lines.push("Findings");
    for (const finding of inventory.findings) lines.push(`  ${finding.message}`);
    lines.push(plural(inventory.findings.length, "finding"));
  }
  return lines.join("\n");
};

const cell = (text: string): string => text.replaceAll("|", "\\|");

const row = (cells: readonly string[]): string => `| ${cells.map(cell).join(" | ")} |`;

const table = (head: readonly string[], rows: readonly (readonly string[])[]): string[] => [
  row(head),
  row(head.map(() => "---")),
  ...rows.map(row),
];

/**
 * The record as a Markdown document, for whoever keeps the record of processing activities.
 */
export const formatInventoryMarkdown: FormatInventoryFunction = (inventory) => {
  const lines: string[] = [
    "# Record of processing activities",
    "",
    "What the app's code and configuration say for article 30 of the GDPR. The controller, its representative and data protection officer, and the security measures outside the app are the controller's to add.",
    "",
    "## Categories of personal data",
    "",
    ...table(
      [
        "Category",
        "Legal basis",
        "Special categories (article 9)",
        "Criminal data (article 10)",
        "Purposes",
        "Processed for",
        "Sources",
        "Returned by ports",
        "Time limit for erasure",
        "Kept past erasure (article 17(3))",
        "Fields",
      ],
      inventory.categories.map((category) => [
        category.name,
        basisOf(category.basis),
        category.special === null ? "none" : specialOf(category.special),
        category.criminal === null ? "none" : criminalOf(category.criminal),
        purposesOf(category),
        processedForOf(category),
        sourcesOf(category),
        category.ports.length === 0
          ? "none"
          : category.ports.map((port) => `\`${port}\``).join(", "),
        retentionOf(category.retention),
        exemptionsOf(category),
        String(category.fields),
      ]),
    ),
    "",
    "## Automated decisions",
    "",
    ...(inventory.automatedDecisions.length === 0
      ? ["The app makes no decision about a person by automated means alone."]
      : table(
          [
            "Decision",
            "Categories",
            "Profiling",
            "Ground",
            "Logic",
            "Significance",
            "Consequences",
            "Special categories (article 22(4))",
            "Measures",
          ],
          inventory.automatedDecisions.map((decision) => [
            decision.name,
            decision.categories.join(", "),
            decision.profiling ? "yes" : "no",
            decision.ground,
            decision.logic,
            decision.significance,
            decision.consequences,
            specialDecidedOn(decision, inventory) || "none",
            decision.measures ?? "none declared",
          ]),
        )),
    "",
    "## Where personal data is kept",
    "",
  ];
  if (inventory.holders.length === 0) {
    lines.push("No field is marked personal.");
  } else {
    lines.push(
      ...table(
        ["Holder", "Field", "Category", "Whose", "How", "Kept in"],
        inventory.holders.flatMap((holder) =>
          (holder.fields.length === 0 ? [null] : holder.fields).map((field) => [
            `${KINDS[holder.kind]} \`${holder.name}\``,
            field === null ? "(names the person only)" : `\`${field.name}\``,
            field?.category ?? "",
            whose(holder),
            field === null ? "" : SEALING[field.sealing],
            `${holder.stores.map((store) => STORES[store]).join(", ")} (${placed(holder.database, holder.location)})`,
          ]),
        ),
      ),
    );
  }
  lines.push("", "## Recipients", "");
  if (inventory.recipients.length === 0) {
    lines.push("No port declares a recipient.");
  } else {
    lines.push(
      ...table(
        ["Port", "Recipient", "Kind", "Country", "Transfer safeguard", "Categories"],
        inventory.recipients.map((recipient) => [
          `\`${recipient.port}\``,
          recipient.name,
          recipient.kind,
          recipient.country,
          recipient.safeguard ?? "inside the EEA",
          recipient.categories.join(", "),
        ]),
      ),
    );
  }
  lines.push(
    "",
    "## Kept by the runtime",
    "",
    ...table(
      ["Record", "Holds", "Kept", "Where"],
      inventory.records.map((record) => [
        record.name,
        RECORDS[record.name].holds,
        keptFor(record),
        placed(record.where, record.location),
      ]),
    ),
    "",
    "## Keys",
    "",
    ...security(inventory).map((text) => `- ${text}`),
  );
  if (inventory.notPersonal.length > 0) {
    lines.push(
      "",
      "## Declared not personal",
      "",
      ...table(
        ["Holder", "Field"],
        inventory.notPersonal.map((field) => [
          `${KINDS[field.kind]} \`${field.name}\``,
          `\`${field.field}\``,
        ]),
      ),
    );
  }
  lines.push("", "## Findings", "");
  if (inventory.findings.length === 0) {
    lines.push("None: every field is classified.");
  } else {
    lines.push(...inventory.findings.map((finding) => `- ${finding.message}`));
  }
  return lines.join("\n");
};
