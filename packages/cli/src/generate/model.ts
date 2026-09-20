/**
 * A user module found on disk. `path` is absolute; `relativePath` is relative to the project
 * root, with forward slashes, and is what generated imports are built from.
 */
export interface ModuleRef {
  readonly path: string;
  readonly relativePath: string;
}

export interface EventModel extends ModuleRef {
  /**
   * The registry key, camelCase from the file name: `order-placed.ts` → `orderPlaced`.
   */
  readonly key: string;
  /**
   * The event type name: `OrderPlaced`.
   */
  readonly typeName: string;
}

/**
 * A collaborator implementation: `audit-log.memory.ts` → name `auditLog`, implementation
 * `memory`.
 */
export interface CollaboratorModel extends ModuleRef {
  readonly name: string;
  readonly implementation: string;
}

export interface CommandModel extends ModuleRef {
  readonly key: string;
  readonly typeName: string;
  /**
   * Set when the command is a directory (`commands/<name>/index.ts`), where collaborators live.
   */
  readonly directory: string | null;
  readonly collaborators: readonly CollaboratorModel[];
}

export interface PolicyModel extends ModuleRef {
  readonly key: string;
  /**
   * The event key derived from the `...-on-<event>` suffix of the file name, or `null` when the
   * module has to declare `on` itself.
   */
  readonly triggerKey: string | null;
}

export interface ProcessHandlerModel extends ModuleRef {
  /**
   * The event key from `on-<event>.ts`.
   */
  readonly eventKey: string;
}

export interface ProcessModel extends ModuleRef {
  readonly key: string;
  readonly typeName: string;
  readonly directory: string;
  readonly handlers: readonly ProcessHandlerModel[];
  readonly timeout: ModuleRef | null;
}

export interface AggregateModel {
  readonly name: string;
  readonly directory: string;
  readonly state: ModuleRef | null;
  readonly events: readonly EventModel[];
  readonly commands: readonly CommandModel[];
  readonly policies: readonly PolicyModel[];
  readonly processes: readonly ProcessModel[];
}

export interface ProjectionModel extends ModuleRef {
  /**
   * The event key from the file name: `order-placed.ts` → `orderPlaced`.
   */
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
  readonly projections: readonly ProjectionModel[];
  readonly queries: readonly QueryModel[];
}

/**
 * Everything the generator knows about a project, in a stable order: aggregates, read models and
 * their modules sorted by name.
 */
export interface ProjectModel {
  readonly root: string;
  readonly appDir: string;
  readonly aggregates: readonly AggregateModel[];
  readonly readModels: readonly ReadModelModel[];
}
