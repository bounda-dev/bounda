import type { AdapterDefinition } from "../../adapter/adapter-definition.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { FieldsRecord } from "../../modules/view.ts";
import { adapterForReadModel } from "../read-model/build-read-models.ts";

export interface LogClearFieldsArgs {
  readonly readModels: Readonly<Record<string, { readonly fields: FieldsRecord }>>;
  readonly config: ResolvedConfig;
  /**
   * The adapters whose database is encrypted under the tenant's keys.
   */
  readonly encrypted: ReadonlySet<AdapterDefinition>;
  readonly logger: Logger;
}

export interface LogClearFieldsFunction {
  (args: LogClearFieldsArgs): void;
}

// The fields marked `.personal({ clear: true })` in a database no key of the tenant's encrypts,
// whose copies keep them once the tenant is forgotten: the app names them once, as it starts. A
// database in memory keeps no copy.
export const logClearFields: LogClearFieldsFunction = ({
  readModels,
  config,
  encrypted,
  logger,
}) => {
  const fields = Object.entries(readModels).flatMap(([name, { fields: declared }]) => {
    const adapter = adapterForReadModel({ name, config });
    if (encrypted.has(adapter) || adapter.ephemeralKeys !== undefined) return [];
    return Object.entries(declared)
      .filter(([, field]) => field.mark === "personal" && field.clear)
      .map(([field]) => `${name}.${field}`);
  });
  if (fields.length === 0) return;
  logger.warn(
    "bounda keeps these personal fields in the clear in a database not encrypted under the tenant's key: forgetting the tenant deletes them from the database, not from its copies",
    { fields },
  );
};
