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
  /**
   * `order-placed.upcast.ts` next to the event, when its payload has changed shape.
   */
  readonly upcasts: ModuleRef | null;
}

/**
 * An implementation of a port: `notifier/in-memory.ts`. `name` is the file name as the
 * configuration names it, `in-memory`.
 */
export interface ImplementationModel extends ModuleRef {
  readonly name: string;
}

/**
 * A port of an aggregate, `order/notifier/`: its `index.ts` exports the interface `typeName`,
 * and every other module in the directory implements it.
 */
export interface PortModel {
  /**
   * The registry key and the name every handler receives it as: `audit-log/` → `auditLog`.
   */
  readonly key: string;
  /**
   * The interface `index.ts` exports: `AuditLog`.
   */
  readonly typeName: string;
  readonly contract: ModuleRef;
  /**
   * Sorted by name; never empty.
   */
  readonly implementations: readonly ImplementationModel[];
}

export interface CommandModel extends ModuleRef {
  readonly key: string;
  readonly typeName: string;
}

export interface PolicyModel extends ModuleRef {
  readonly key: string;
  /**
   * The event key derived from the `...-on-<event>` suffix of the file name, or `null` when the
   * module has to declare `on` itself.
   */
  readonly triggerKey: string | null;
  /**
   * The aggregate whose events the policy reacts to when it sits in `policies/<aggregate>/`;
   * `null` for the owner's own events. Its key is then prefixed with that aggregate:
   * `policies/payment/refund-on-payment-failed.ts` → `paymentRefundOnPaymentFailed`.
   */
  readonly source: string | null;
}

export interface ProcessHandlerModel extends ModuleRef {
  /**
   * The aggregate of the event: the process's own for `on-<event>.ts`, the folder's for
   * `<aggregate>/on-<event>.ts`.
   */
  readonly aggregate: string;
  /**
   * The event key from `on-<event>.ts`.
   */
  readonly eventKey: string;
}

export interface ProcessDeadlineModel extends ModuleRef {
  /**
   * The state field from `at-<field>.ts`: `nextReminder`, or `timeout` for `at-timeout.ts`.
   */
  readonly field: string;
}

export interface ProcessModel extends ModuleRef {
  readonly key: string;
  readonly typeName: string;
  readonly directory: string;
  readonly handlers: readonly ProcessHandlerModel[];
  /**
   * One per `at-<field>.ts`, in file name order.
   */
  readonly deadlines: readonly ProcessDeadlineModel[];
}

export interface AggregateModel {
  readonly name: string;
  readonly directory: string;
  readonly state: ModuleRef | null;
  readonly events: readonly EventModel[];
  /**
   * The ports of the aggregate, sorted by key.
   */
  readonly collaborators: readonly PortModel[];
  readonly commands: readonly CommandModel[];
  readonly policies: readonly PolicyModel[];
  readonly processes: readonly ProcessModel[];
}

export interface ProjectionModel extends ModuleRef {
  /**
   * The aggregate whose event it projects, from its folder: `projections/order/...` → `order`.
   */
  readonly aggregate: string;
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
