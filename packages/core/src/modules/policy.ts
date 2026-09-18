/**
 * The shape of a policy module. `on` overrides the event type derived from the file name and may
 * list several events.
 */
export interface PolicyModule {
  readonly handler: (args: never) => unknown;
  readonly on?: string | readonly string[];
}

/**
 * Arguments of a policy `handler`: the event that triggered it and the typed commands facade.
 */
export interface PolicyHandlerArgs<Event, Commands> {
  readonly event: Event;
  readonly commands: Commands;
}
