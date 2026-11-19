import { ConfigurationError } from "../../contracts/errors.ts";
import type { Registry } from "../../modules/registry.ts";
import type { PersonalCategories } from "../personal-data/categories.ts";

export interface ReturnedRead {
  readonly person: string;
  readonly categories: readonly string[];
}

type Persons = (call: never) => unknown;

interface CallDeclaration {
  readonly persons: Persons;
  readonly personsOnError: Persons | undefined;
  readonly categories: readonly string[];
}

// What a port's calls return of whom: its own calls, for a port that is a function, or its
// methods'; a method left out or declared `false` returns nobody's.
type PortDeclaration =
  | { readonly call: CallDeclaration }
  | { readonly methods: Readonly<Record<string, CallDeclaration>> };

export interface PortReturns {
  // Only the ports whose calls return someone's personal data.
  readonly byOwner: Readonly<Record<string, Readonly<Record<string, PortDeclaration>>>>;
}

export interface BuildPortReturnsArgs {
  readonly registry: Registry;
  readonly categories: PersonalCategories;
}

export interface BuildPortReturnsFunction {
  (args: BuildPortReturnsArgs): PortReturns;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const checkedCall = (
  where: string,
  declared: Readonly<Record<string, unknown>>,
  categories: PersonalCategories,
): CallDeclaration => {
  const fail = (message: string): never => {
    throw new ConfigurationError(`${where}: ${message}`);
  };
  const { persons, personsOnError, categories: named } = declared;
  if (typeof persons !== "function") {
    fail("persons must be a function of the call, naming whose personal data it returned");
  }
  if (personsOnError !== undefined && typeof personsOnError !== "function") {
    fail(
      "personsOnError must be a function of the failed call, naming whose data its error may quote",
    );
  }
  if (named === undefined) {
    return {
      persons: persons as Persons,
      personsOnError: personsOnError as Persons | undefined,
      categories: [categories.default.name],
    };
  }
  if (!Array.isArray(named) || named.length === 0) {
    fail("categories must list the categories of the personal data returned");
  }
  for (const category of named as readonly unknown[]) {
    if (categories.of(category as string) === undefined) {
      fail(`categories names ${JSON.stringify(category)}, which the app does not have`);
    }
  }
  if (new Set(named as readonly string[]).size !== (named as readonly string[]).length) {
    fail("categories names a category twice");
  }
  return {
    persons: persons as Persons,
    personsOnError: personsOnError as Persons | undefined,
    categories: named as readonly string[],
  };
};

// `null` for a port whose calls return nobody's personal data.
const checkedPort = (
  port: string,
  declared: unknown,
  categories: PersonalCategories,
): PortDeclaration | null => {
  const where = `Port ${port}: returnsPersonalData`;
  if (declared === false) return null;
  if (!isRecord(declared)) {
    throw new ConfigurationError(
      `${where} must be false, what the port returns, or an object of what each method returns`,
    );
  }
  // A method form never maps to a function, so a top-level `persons` function is a call's.
  if (typeof declared.persons === "function") {
    return { call: checkedCall(where, declared, categories) };
  }
  const methods: Record<string, CallDeclaration> = {};
  for (const [method, entry] of Object.entries(declared)) {
    if (entry === false) continue;
    if (!isRecord(entry)) {
      throw new ConfigurationError(
        `${where}.${method} must be false or what the method returns: { persons, categories }`,
      );
    }
    methods[method] = checkedCall(`${where}.${method}`, entry, categories);
  }
  return Object.keys(methods).length === 0 ? null : { methods };
};

export const buildPortReturns: BuildPortReturnsFunction = ({ registry, categories }) => {
  const byOwner: Record<string, Record<string, PortDeclaration>> = {};
  const owners = [...Object.entries(registry.aggregates), ...Object.entries(registry.readModels)];
  for (const [owner, entry] of owners) {
    for (const [name, module] of Object.entries(entry.returns ?? {})) {
      const port = `${owner}.${name}`;
      if (entry.ports?.[name] === undefined) {
        throw new ConfigurationError(
          `Port ${port}: it exports returnsPersonalData and has no implementation in infrastructure/${name}/`,
        );
      }
      const declaration = checkedPort(port, module.returnsPersonalData, categories);
      if (declaration === null) continue;
      byOwner[owner] = { ...byOwner[owner], [name]: declaration };
    }
  }
  return { byOwner };
};

// Runs before the caller receives the answer, so a refusal it throws keeps the data from it.
export interface ReturnsRun {
  read(reads: readonly ReturnedRead[]): Promise<void>;
}

export interface PersonsOfFunction {
  (where: string, named: unknown): readonly string[];
}

export const personsOf: PersonsOfFunction = (where, named) => {
  const all = Array.isArray(named) ? (named as readonly unknown[]) : [named];
  const persons: string[] = [];
  for (const person of all) {
    if (person === null || person === undefined) continue;
    if (typeof person !== "string" || person === "") {
      throw new ConfigurationError(
        `${where} named ${JSON.stringify(person)}, which is no person id`,
      );
    }
    persons.push(person);
  }
  return [...new Set(persons)];
};

const readsOf = (persons: readonly string[], categories: readonly string[]): ReturnedRead[] =>
  persons.map((person) => ({ person, categories }));

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as { readonly then?: unknown } | null | undefined)?.then === "function";

const called = (
  where: string,
  declaration: CallDeclaration,
  run: ReturnsRun,
  call: () => unknown,
  args: readonly unknown[],
): Promise<unknown> => {
  let answered: unknown;
  try {
    answered = call();
  } catch (error) {
    return failed(where, declaration, run, args, error);
  }
  if (!isThenable(answered)) {
    throw new ConfigurationError(
      `${where} answered without a promise, and returnsPersonalData says it returns personal data: make it answer a promise`,
    );
  }
  return Promise.resolve(answered).then(
    async (result) => {
      const persons = personsOf(
        `${where}: persons`,
        declaration.persons({ args, result } as never),
      );
      await run.read(readsOf(persons, declaration.categories));
      return result;
    },
    (error: unknown) => failed(where, declaration, run, args, error),
  );
};

const failed = async (
  where: string,
  declaration: CallDeclaration,
  run: ReturnsRun,
  args: readonly unknown[],
  error: unknown,
): Promise<never> => {
  if (declaration.personsOnError !== undefined) {
    const persons = personsOf(
      `${where}: personsOnError`,
      declaration.personsOnError({ args, error } as never),
    );
    await run.read(readsOf(persons, declaration.categories));
  }
  throw error;
};

const wrapped = (
  port: string,
  declaration: PortDeclaration,
  implementation: unknown,
  run: ReturnsRun,
): unknown => {
  if (
    (typeof implementation !== "object" && typeof implementation !== "function") ||
    implementation === null
  ) {
    return implementation;
  }
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(implementation, {
    apply: (target, self, args: unknown[]) =>
      "call" in declaration
        ? called(
            `Port ${port}`,
            declaration.call,
            run,
            () => Reflect.apply(target as (...args: unknown[]) => unknown, self, args),
            args,
          )
        : Reflect.apply(target as (...args: unknown[]) => unknown, self, args),
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function" || !("methods" in declaration)) return value;
      const method = Object.hasOwn(declaration.methods, property)
        ? declaration.methods[property as string]
        : undefined;
      if (method === undefined) return value;
      if (!methods.has(property)) {
        methods.set(property, (...args: unknown[]) =>
          called(
            `Port ${port}: method ${String(property)}`,
            method,
            run,
            () => (value as (...args: unknown[]) => unknown).apply(target, args),
            args,
          ),
        );
      }
      return methods.get(property);
    },
  });
};

export interface BindReturnsFunction {
  (
    returns: PortReturns,
    owner: string,
    ports: Readonly<Record<string, unknown>>,
    run: ReturnsRun,
  ): Readonly<Record<string, unknown>>;
}

// A port is read lazily: a test app's missing port throws only where it is used.
export const bindReturns: BindReturnsFunction = (returns, owner, ports, run) => {
  const own = returns.byOwner[owner];
  if (own === undefined) return ports;
  const bound: Record<string, unknown> = {};
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(ports))) {
    const declaration = own[name];
    if (declaration === undefined) {
      Object.defineProperty(bound, name, descriptor);
      continue;
    }
    let built: { readonly port: unknown } | undefined;
    Object.defineProperty(bound, name, {
      enumerable: true,
      get: () => {
        built ??= {
          port: wrapped(`${owner}.${name}`, declaration, Reflect.get(ports, name), run),
        };
        return built.port;
      },
    });
  }
  return bound;
};
