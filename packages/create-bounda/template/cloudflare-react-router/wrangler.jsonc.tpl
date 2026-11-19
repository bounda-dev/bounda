/**
 * For more details on how to configure Wrangler, refer to:
 * https://developers.cloudflare.com/workers/wrangler/configuration/
 */
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "{{name}}",
  "main": "./workers/app.ts",
  "compatibility_date": "2026-09-21",
  // Every tenant gets its own Store, with its own SQLite, and its own Keeper, which holds its key
  // and forget ledger apart from it, so forgetting the tenant reaches every restore of its store.
  "durable_objects": {
    "bindings": [
      { "name": "STORE", "class_name": "Store" },
      { "name": "KEEPER", "class_name": "Keeper" }
    ]
  },
  // Both keep what they hold in SQLite, so the classes are created as SQLite classes.
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Store", "Keeper"] }],
  "observability": { "enabled": true },
  "upload_source_maps": true
}
