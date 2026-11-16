import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import { resolveConfig } from "../../config/schema.ts";
import { memory } from "../../memory/index.ts";
import { fieldBuilder as f } from "../../modules/view.ts";
import { createRecordingLogger } from "../test-support.ts";
import { logClearFields } from "./clear-fields.ts";

const directory = mkdtempSync(join(tmpdir(), "bounda-clear-fields-"));

const readModels = {
  customers: {
    fields: {
      customerId: f.string().primaryKey().person(),
      email: f.string().personal(),
      contact: f.string().personal({ clear: true }),
      city: f.string(),
    },
  },
  notes: {
    fields: { noteId: f.string().primaryKey(), author: f.string().personal({ clear: true }) },
  },
};

describe("logClearFields", () => {
  it("names once the fields kept in the clear in a database not encrypted under the tenant's key", () => {
    const files = createNodeSqliteAdapter(join(directory, "app.db")).adapter;
    const notes = memory();
    const recording = createRecordingLogger();
    logClearFields({
      readModels,
      config: resolveConfig({ storage: files, readModels: { notes } }),
      encrypted: new Set(),
      logger: recording.logger,
    });
    expect(recording.entries).toEqual([
      {
        level: "warn",
        message:
          "bounda keeps these personal fields in the clear in a database not encrypted under the tenant's key: forgetting the tenant deletes them from the database, not from its copies",
        fields: { fields: ["customers.contact"] },
      },
    ]);
  });

  it("says nothing of a database encrypted under the tenant's key, or in memory", () => {
    const files = createNodeSqliteAdapter(join(directory, "keyed.db")).adapter;
    const recording = createRecordingLogger();
    logClearFields({
      readModels,
      config: resolveConfig({ storage: files, readModels: { notes: memory() } }),
      encrypted: new Set([files]),
      logger: recording.logger,
    });
    expect(recording.entries).toEqual([]);
  });
});
