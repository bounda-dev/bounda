/**
 * The event or command type name derived from a registry key: `orderPlaced` → `OrderPlaced`.
 */
export type TypeNameOf<Key> = Key extends string ? Capitalize<Key> : never;

export type CapitalizeFunction = <Name extends string>(name: Name) => Capitalize<Name>;

/**
 * Upper-cases the first character.
 */
export const capitalize: CapitalizeFunction = (name) =>
  `${name.charAt(0).toUpperCase()}${name.slice(1)}` as Capitalize<typeof name>;

export interface ToCamelCaseFunction {
  (name: string): string;
}

/**
 * Converts a kebab-case file name to the camelCase key the registry uses: `order-placed` →
 * `orderPlaced`.
 */
export const toCamelCase: ToCamelCaseFunction = (name) =>
  name.replace(/-+([a-zA-Z0-9])/g, (_, character: string) => character.toUpperCase());

/**
 * Flattens an intersection so hovers show one object type instead of `A & B`.
 */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Turns a union of object types into their intersection.
 */
export type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;
