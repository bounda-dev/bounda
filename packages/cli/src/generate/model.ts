export interface ModuleRef {
  readonly path: string;
  // Relative to the project root, with forward slashes.
  readonly relativePath: string;
}

export interface EventModel extends ModuleRef {
  readonly key: string;
  readonly typeName: string;
  readonly upcasts: ModuleRef | null;
}

export interface ImplementationModel extends ModuleRef {
  // The file name as the configuration names it: `in-memory`.
  readonly name: string;
}

export interface PortModel extends ModuleRef {
  // Also the name every handler receives the port as.
  readonly key: string;
  // The interface the port's module exports.
  readonly typeName: string;
  // Never empty.
  readonly implementations: readonly ImplementationModel[];
}

export interface CommandModel extends ModuleRef {
  readonly key: string;
  readonly typeName: string;
}

export interface PolicyModel extends ModuleRef {
  readonly key: string;
  // The event of the source aggregate the file name ends with after `-on-`; `null` when the module
  // exports `on` or no event matches.
  readonly triggerKey: string | null;
  // The aggregate of `policies/<aggregate>/`, whose key then prefixes the policy's; `null` for the
  // owner's own events.
  readonly source: string | null;
}

export interface ProcessHandlerModel extends ModuleRef {
  // The process's own aggregate for `on-<event>.ts`, the folder's for `<aggregate>/on-<event>.ts`.
  readonly aggregate: string;
  readonly eventKey: string;
}

export interface ProcessDeadlineModel extends ModuleRef {
  // The state field from `at-<field>.ts`, camelCase.
  readonly field: string;
}

export interface ProcessModel extends ModuleRef {
  readonly key: string;
  readonly typeName: string;
  readonly directory: string;
  readonly handlers: readonly ProcessHandlerModel[];
  readonly deadlines: readonly ProcessDeadlineModel[];
}

export interface AggregateModel {
  readonly name: string;
  readonly directory: string;
  readonly state: ModuleRef | null;
  readonly events: readonly EventModel[];
  readonly ports: readonly PortModel[];
  readonly commands: readonly CommandModel[];
  readonly policies: readonly PolicyModel[];
  readonly processes: readonly ProcessModel[];
}

export interface ProjectionModel extends ModuleRef {
  readonly aggregate: string;
  readonly eventKey: string;
}

export interface QueryModel extends ModuleRef {
  readonly key: string;
  readonly typeName: string;
}

export interface ReadModelModel {
  readonly name: string;
  readonly directory: string;
  readonly view: ModuleRef;
  // Only the read model's query handlers receive them.
  readonly ports: readonly PortModel[];
  readonly projections: readonly ProjectionModel[];
  readonly queries: readonly QueryModel[];
}

/**
 * Something the generator went on despite: a layout that is most likely a mistake without
 * breaking a convention, such as a module that looks like an event and is not one, or something
 * state inference could not do.
 */
export interface GenerateWarning {
  /**
   * The aggregate or read model, by key.
   */
  readonly module: string;
  readonly message: string;
}

export interface ProjectModel {
  readonly root: string;
  readonly appDir: string;
  readonly aggregates: readonly AggregateModel[];
  readonly readModels: readonly ReadModelModel[];
}
