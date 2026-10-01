export interface WithCollaboratorsFunction {
  <A extends object>(collaborators: Readonly<Record<string, unknown>>, args: A): A;
}

/**
 * A handler's arguments with its aggregate's ports beside them. Copies property descriptors
 * instead of spreading, because a spread reads every port, and a test app's port that was given
 * nothing throws when read: it must throw only in the handler that uses it.
 */
export const withCollaborators: WithCollaboratorsFunction = (collaborators, args) =>
  Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(collaborators),
      ...Object.getOwnPropertyDescriptors(args),
    },
  ) as typeof args;
