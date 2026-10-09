import { ConfigurationError } from "../contracts/errors.ts";
import { capitalize } from "./naming.ts";
import type { PortModules } from "./port.ts";
import { projectionTriggers } from "./projection.ts";
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

const optionalFunction = (problems: Problem[], owner: object, path: string, name: string): void => {
  const value: unknown = Reflect.get(owner, name);
  if (value !== undefined && !isFunction(value)) {
    problems.push({ path, message: `export "${name}" must be a function` });
  }
};

const requireFolding = (problems: Problem[], event: object, path: string): void => {
  const exported = ["begin", "evolve"].filter((name) => Reflect.get(event, name) !== undefined);
  if (exported.length === 0) {
    problems.push({ path, message: 'missing export "begin" or "evolve" (expected a function)' });
  }
  for (const name of exported) requireFunction(problems, event, path, name);
};

const requireImplementations = (
  problems: Problem[],
  ports: PortModules | undefined,
  path: string,
): void => {
  for (const [port, implementations] of Object.entries(ports ?? {})) {
    if (Object.keys(implementations).length === 0) {
      problems.push({ path: `${path}.${port}`, message: "has no implementations" });
    }
    for (const [name, module] of Object.entries(implementations)) {
      const at = `${path}.${port}.${name}`;
      const exported = isRecord(module) ? module : {};
      const hasDefault = Reflect.get(exported, "default") !== undefined;
      const create: unknown = Reflect.get(exported, "create");
      if (hasDefault && create !== undefined) {
        problems.push({ path: at, message: 'exports both "default" and "create" (expected one)' });
      } else if (create !== undefined && !isFunction(create)) {
        problems.push({ path: at, message: 'export "create" must be a function' });
      } else if (!hasDefault && create === undefined) {
        problems.push({ path: at, message: 'missing export "default" or "create"' });
      }
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
    requireFolding(problems, event, `${base}.events.${key}`);
    optionalFunction(problems, event, `${base}.events.${key}`, "payload");
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
  requireImplementations(problems, aggregate.ports, `${base}.ports`);
  for (const [key, entry] of Object.entries(aggregate.commands)) {
    const path = `${base}.commands.${key}`;
    requireFunction(problems, entry.module, path, "handler");
    optionalFunction(problems, entry.module, path, "payload");
    const rejections: unknown = Reflect.get(entry.module, "rejections");
    if (rejections !== undefined && !isFunction(rejections)) {
      problems.push({
        path,
        message: 'export "rejections" must be a function returning a message for each code',
      });
    }
  }
  for (const [key, policy] of Object.entries(aggregate.policies)) {
    requireFunction(problems, policy.module, `${base}.policies.${key}`, "handler");
  }
  for (const [key, process] of Object.entries(aggregate.processes)) {
    // A reaction's qualified name is its identity in the inbox: sharing it, the policy and the
    // process would each skip the events the other handled.
    if (Object.hasOwn(aggregate.policies, key)) {
      problems.push({
        path: `${base}.processes.${key}`,
        message: `is also the name of ${base}.policies.${key}; give one of them another name`,
      });
    }
    requireFunction(problems, process.module, `${base}.processes.${key}`, "config");
    optionalFunction(problems, process.module, `${base}.processes.${key}`, "state");
    optionalFunction(problems, process.module, `${base}.processes.${key}`, "correlate");
    for (const [source, handlers] of Object.entries(process.handlers)) {
      for (const [event, handler] of Object.entries(handlers)) {
        requireFunction(
          problems,
          handler,
          `${base}.processes.${key}.handlers.${source}.${event}`,
          "handler",
        );
      }
    }
    for (const [field, handler] of Object.entries(process.deadlines ?? {})) {
      requireFunction(problems, handler, `${base}.processes.${key}.deadlines.${field}`, "handler");
    }
  }
};

const validateReadModel = (
  problems: Problem[],
  name: string,
  readModel: Registry["readModels"][string],
  aggregates: Registry["aggregates"],
): void => {
  const base = `readModels.${name}`;
  requireFunction(problems, readModel.view, `${base}.view`, "fields");
  for (const [aggregate, projections] of Object.entries(readModel.projections)) {
    if (!(aggregate in aggregates)) {
      problems.push({
        path: `${base}.projections.${aggregate}`,
        message: `there is no aggregate "${aggregate}" whose events to project`,
      });
    }
    const events = new Set<string>(
      Object.keys(aggregates[aggregate]?.events ?? {}).map(capitalize),
    );
    for (const [key, projection] of Object.entries(projections)) {
      const path = `${base}.projections.${aggregate}.${key}`;
      requireFunction(problems, projection, path, "project");
      if (!(aggregate in aggregates)) continue;
      for (const trigger of projectionTriggers(key, projection).filter(
        (type) => !events.has(type),
      )) {
        problems.push({
          path,
          message: `"${trigger}" is not an event of the aggregate "${aggregate}"; name the file after one or export "on"`,
        });
      }
    }
  }
  for (const [key, query] of Object.entries(readModel.queries)) {
    requireFunction(problems, query, `${base}.queries.${key}`, "handler");
    optionalFunction(problems, query, `${base}.queries.${key}`, "payload");
    optionalFunction(problems, query, `${base}.queries.${key}`, "repository");
  }
  requireImplementations(problems, readModel.ports, `${base}.ports`);
};

export interface ValidateRegistryFunction {
  (registry: Registry): void;
}

export const validateRegistry: ValidateRegistryFunction = (registry) => {
  const problems: Problem[] = [];
  for (const [name, aggregate] of Object.entries(registry.aggregates)) {
    validateAggregate(problems, name, aggregate);
  }
  for (const [name, readModel] of Object.entries(registry.readModels)) {
    validateReadModel(problems, name, readModel, registry.aggregates);
  }
  if (problems.length > 0) {
    const details = problems.map((problem) => `  ${problem.path}: ${problem.message}`).join("\n");
    throw new ConfigurationError(`Invalid registry:\n${details}`);
  }
};
