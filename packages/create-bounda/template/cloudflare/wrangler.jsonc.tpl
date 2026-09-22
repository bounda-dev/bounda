{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "{{name}}",
  "main": "src/worker.ts",
  "assets": { "directory": "./public" },
  "compatibility_date": "2026-09-21",
  "durable_objects": {
    "bindings": [{ "name": "STORE", "class_name": "Store" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Store"] }],
  "observability": { "enabled": true }
}
