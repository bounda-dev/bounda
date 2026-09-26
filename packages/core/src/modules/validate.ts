import { ConfigurationError } from "../contracts/errors.ts";
import type { CollaboratorImplementations } from "./command.ts";
import type { Registry } from "./registry.ts";

interface Problem {
  readonly path: string;
  readonly message: string;
}

const isFunction = (value: unknown): boolean => typeof value === "function";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const requireFunction = (problems: Problem[], owner: object, path: string, name: string): void => {
  if (!isFunction(Reflect.get(owner, name))) {
    problems.push({ path, message: `missing export "${name}" (expected a function)` });
  }
};

const requireImplementations = (
  problems: Problem[],
  collaborators: CollaboratorImplementations | undefined,
  path: string,
): void => {
  for (const [collaborator, implementations] of Object.entries(collaborators ?? {})) {
    if (Object.keys(implementations).length === 0) {
      problems.push({
        path: `${path}.collaborators.${collaborator}`,
        message: "has no implementations",
      });
    }
  }
};

const validateAggregate = (
  problems: Problem[],
  name: string,
  aggregate: Registry["aggregates"][string],
): void => {
  const base = `aggregates.${name}`;
  if (aggregate.state !== undefined && !isRecord(aggregate.state.initialState)) {
    problems.push({ path: `${base}.state`, message: 'export "initialState" must be an object' });
  }
  for (const [key, event] of Object.entries(aggregate.events)) {
    requireFunction(problems, event, `${base}.events.${key}`, "apply");
  }
  for (const [key, module] of Object.entries(aggregate.upcasts ?? {})) {
    const path = `${base}.upcasts.${key}`;
    if (!(key in aggregate.events)) {
      problems.push({ path, message: `there is no event "${key}" to upcast` });
    }
    const upcasts: unknown = Reflect.get(module, "upcasts");
    if (!Array.isArray(upcasts) || upcasts.length === 0 || !upcasts.every(isFunction)) {
      problems.push({
        path,
        message: 'export "upcasts" must be a non-empty array of functions, oldest version first',
      });
    }
  }
  for (const [key, entry] of Object.entries(aggregate.commands)) {
    requireFunction(problems, entry.module, `${base}.commands.${key}`, "handler");
    requireImplementations(problems, entry.collaborators, `${base}.commands.${key}`);
  }
  for (const [key, policy] of Object.entries(aggregate.policies)) {
    requireFunction(problems, policy.module, `${base}.policies.${key}`, "handler");
    requireImplementations(problems, policy.collaborators, `${base}.policies.${key}`);
  }
  for (const [key, process] of Object.entries(aggregate.processes)) {
    requireFunction(problems, process.module, `${base}.processes.${key}`, "config");
    for (const [event, handler] of Object.entries(process.handlers)) {
      requireFunction(problems, handler, `${base}.processes.${key}.handlers.${event}`, "handler");
    }
    if (process.timeout !== undefined) {
      requireFunction(problems, process.timeout, `${base}.processes.${key}.timeout`, "handler");
    }
    requireImplementations(problems, process.collaborators, `${base}.processes.${key}`);
  }
};

const validateReadModel = (
  problems: Problem[],
  name: string,
  readModel: Registry["readModels"][string],
): void => {
  const base = `readModels.${name}`;
  requireFunction(problems, readModel.view, `${base}.view`, "fields");
  for (const [key, projection] of Object.entries(readModel.projections)) {
    requireFunction(problems, projection, `${base}.projections.${key}`, "project");
  }
  for (const [key, query] of Object.entries(readModel.queries)) {
    requireFunction(problems, query, `${base}.queries.${key}`, "handler");
  }
};

export interface ValidateRegistryFunction {
  (registry: Registry): void;
}

/**
 * Checks that every module in the registry exports what its kind requires. Throws one
 * `ConfigurationError` listing every problem with its registry path.
 */
export const validateRegistry: ValidateRegistryFunction = (registry) => {
  const problems: Problem[] = [];
  for (const [name, aggregate] of Object.entries(registry.aggregates)) {
    validateAggregate(problems, name, aggregate);
  }
  for (const [name, readModel] of Object.entries(registry.readModels)) {
    validateReadModel(problems, name, readModel);
  }
  if (problems.length > 0) {
    const details = problems.map((problem) => `  ${problem.path}: ${problem.message}`).join("\n");
    throw new ConfigurationError(`Invalid registry:\n${details}`);
  }
};
