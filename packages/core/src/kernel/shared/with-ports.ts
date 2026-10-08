export interface WithPortsFunction {
  <A extends object>(ports: Readonly<Record<string, unknown>>, args: A): A;
}

/**
 * A handler's arguments with its module's ports beside them. Copies property descriptors
 * instead of spreading, because a spread reads every port, and a test app's port that was given
 * nothing throws when read: it must throw only in the handler that uses it.
 */
export const withPorts: WithPortsFunction = (ports, args) =>
  Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(ports),
      ...Object.getOwnPropertyDescriptors(args),
    },
  ) as typeof args;
