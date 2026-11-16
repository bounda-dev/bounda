import type {
  InventoryHolder,
  InventoryHolderKind,
  InventoryRecord,
  InventoryRecordName,
  InventorySealing,
  InventoryStore,
  PersonalDataInventory,
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
      "the answer of each command dispatched with an idempotency key, sealed under its persons",
    kept: "until erased by a forgetting",
  },
  "dead-letters": {
    holds:
      "the payload of each command that gave up, and the error text of failed work, sealed under the persons it names",
    kept: "for good once retried or discarded, unreadable once their person is forgotten",
  },
  disclosures: {
    holds: "which categories of whose data went to each recipient, and when",
    kept: "for as long as the database",
  },
  "forget-ledger": {
    holds: "each forgetting's person, categories and reason, outside the database",
    kept: "for good",
  },
  "access-log": {
    holds: "every access to personal data, by ids, handed to app/audit.ts",
    kept: "as the app keeps it",
  },
};

const keptFor = (record: InventoryRecord): string => {
  if (record.keptFor === null) return RECORDS[record.name].kept;
  if (record.name === "dead-letters") {
    return `retried or discarded letters for ${record.keptFor}, failed ones until resolved; unreadable once their person is forgotten`;
  }
  if (record.name === "remembered-answers") {
    return `${record.keptFor}, or until erased by a forgetting`;
  }
  return record.keptFor;
};

const whose = (holder: InventoryHolder): string => {
  if (holder.person !== null) return `the person in ${holder.person}`;
  return holder.kind === "process-state" ? "the instance's id" : "the aggregate's id";
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

const basisOf = (basis: string | null): string => basis ?? "no basis declared";

const retentionOf = (retention: string | null): string =>
  retention === null ? "kept until forgotten" : `forgotten ${retention} after last activity`;

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
      `    kept in: ${holder.stores.map((store) => STORES[store]).join(", ")} (${holder.database})`,
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
      `  ${record.name}  ${RECORDS[record.name].holds}; ${keptFor(record)} (${record.where})`,
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
    "What the app's code and configuration say for article 30 of the GDPR. The controller, its representative and data protection officer, the purposes in words and the security measures outside the app are the controller's to add.",
    "",
    "## Categories of personal data",
    "",
    ...table(
      ["Category", "Legal basis", "Time limit for erasure", "Fields"],
      inventory.categories.map((category) => [
        category.name,
        basisOf(category.basis),
        retentionOf(category.retention),
        String(category.fields),
      ]),
    ),
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
            `${holder.stores.map((store) => STORES[store]).join(", ")} (${holder.database})`,
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
        record.where,
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
