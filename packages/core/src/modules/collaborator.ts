/**
 * The shape of an implementation module of a collaborator, `<aggregate>/<port>/<name>.ts`: its
 * default export is what the aggregate's handlers receive as the port. The generated registry
 * checks every implementation against this with the port's interface, so one that does not
 * fulfil the contract does not compile.
 */
export interface ImplementationModule<Port> {
  readonly default: Port;
}

/**
 * The collaborators of one aggregate as the registry holds them: by port and then by
 * implementation file name, `collaborators.notifier.smtp`.
 */
export type CollaboratorModules = Readonly<
  Record<string, Readonly<Record<string, ImplementationModule<unknown>>>>
>;
