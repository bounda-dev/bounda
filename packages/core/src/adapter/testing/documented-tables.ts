// The tables "What an adapter creates" lists in the adapters' page of the docs, in its order,
// without their prefix: `storageSchemaContract` holds every engine to them, and
// `documented-tables.test.ts` holds the page to them.
export const DOCUMENTED_TABLES: readonly string[] = [
  "events",
  "checkpoints",
  "inbox",
  "scheduled_commands",
  "dead_letters",
  "idempotency_keys",
  "personal_keys",
  "index_keys",
  "superseded_keys",
  "tenancy",
  "tenant_fence",
  "persons",
  "restrictions",
  "restricted_persons",
  "restricted_positions",
  "disclosures",
  "recipients",
  "snapshots",
  "person_rows",
  "subscriber_failures",
  "migrations",
  "forget_ledger",
  "forget_ledger_marks",
  "forget_ledger_fence",
  "tenant_keys",
];

// Those PostgreSQL does without, which the page says are SQLite's alone.
export const SQLITE_ONLY_TABLES: readonly string[] = ["person_rows"];
