import type { HoldsText } from "./personal.ts";
import type { PersonalCategoryName } from "./personal-data.ts";

/**
 * Whom a call returned personal data of, by person id: one, several, or none; `null` and
 * `undefined` name nobody, so `result?.customerId` reads as it is.
 */
export type ReturnedPersons = string | null | undefined | readonly (string | null | undefined)[];

/**
 * A call of a port that answered: its arguments and what its promise resolved to.
 */
export interface PortCall<Args extends readonly unknown[], Result> {
  readonly args: Args;
  readonly result: Result;
}

/**
 * A call of a port that threw or rejected: its arguments and what it threw.
 */
export interface FailedPortCall<Args extends readonly unknown[]> {
  readonly args: Args;
  readonly error: unknown;
}

/**
 * Whose personal data one method of a port, or a port that is a function, returns. After each
 * call that resolves, `persons` names them; the run that called it then counts as having read
 * their data of `categories`, as if it had opened fields of theirs of those categories: what it
 * writes in free text, an error a dead letter or a subscriber failure keeps or a rejection a
 * command remembers, is encrypted under their keys too, is listed in their export, withheld from
 * anyone else's (article 15(4)), reached by their forgetting and covered by their restriction. A
 * read of a person whose processing is restricted throws `ProcessingRestrictedError` from the call,
 * unless the run names a basis that opens it.
 */
export interface PersonalDataReturned<
  Args extends readonly unknown[],
  Result,
  Category extends string = PersonalCategoryName,
> {
  persons(call: PortCall<Args, Result>): ReturnedPersons;
  /**
   * Whose data the error of a call that failed may quote; nobody's when left out.
   */
  personsOnError?(call: FailedPortCall<Args>): ReturnedPersons;
  /**
   * The categories of the data returned, as `app/personal-data.ts` declares them; `default` when
   * left out.
   */
  readonly categories?: readonly [Category, ...Category[]];
}

type Method = (...args: never) => unknown;

type MethodsOf<Port> = {
  [Key in keyof Port]-?: Port[Key] extends Method ? Key : never;
}[keyof Port];

// What a method answers, its promise awaited.
type Answer<Fn> = Fn extends (...args: never) => infer Result ? Awaited<Result> : never;

type ReturnsText<Fn> = true extends HoldsText<Answer<Fn>> ? true : false;

type TextMethodsOf<Port> = {
  [Key in MethodsOf<Port>]: ReturnsText<Port[Key]> extends true ? Key : never;
}[MethodsOf<Port>];

// A method that answers synchronously can only say it returns no personal data: what a call
// returned is read once its promise settles.
type DeclarationOf<Fn> = Fn extends (...args: infer Args) => infer Result
  ? Result extends PromiseLike<infer Resolved>
    ? PersonalDataReturned<Args, Resolved> | false
    : false
  : never;

type MethodsDeclaration<Port> = {
  readonly [Key in TextMethodsOf<Port>]: DeclarationOf<Port[Key]>;
} & {
  readonly [Key in Exclude<MethodsOf<Port>, TextMethodsOf<Port>>]?: DeclarationOf<Port[Key]>;
};

/**
 * What a port's module exports as `returnsPersonalData`, typed with the port's interface: `false`
 * when no call of it returns personal data; for a port that is a function, `false` or what it
 * returns; for one of methods, an object with each method whose answer can hold text, and any
 * other, mapped to `false` or what it returns. Checked by `.bounda/types.ts`.
 */
export type ReturnsPersonalData<Port> =
  | false
  | (Port extends Method ? DeclarationOf<Port> : MethodsDeclaration<Port>);

/**
 * The shape of a port module that exports `returnsPersonalData`, which the generated registry
 * checks it against.
 */
export interface PortReturnsModule {
  readonly returnsPersonalData: unknown;
}

type CallReturnsText<Port> = Port extends Method ? ReturnsText<Port> : false;

type Unclassified<Port> =
  | (CallReturnsText<Port> extends true ? "itself" : never)
  | (Port extends Method ? never : TextMethodsOf<Port>);

/**
 * `true` when the port `Name`, whose interface is `Port`, answers nothing that can hold text, or
 * its module `Module` exports `returnsPersonalData` as `ReturnsPersonalData<Port>`; otherwise a
 * message saying what to declare, which the generator's `.bounda/types.ts` fails to compile on. A
 * port that is a function, with a method besides that answers what can hold text, is reported:
 * the declaration of a function says what its calls return, so it is split in two.
 */
export type ClassifiesReturns<Name extends string, Module, Port> = Port extends Method
  ? [TextMethodsOf<Port>] extends [never]
    ? ModuleClassifies<Name, Module, Port>
    : `Port ${Name} is a function whose method ${Extract<TextMethodsOf<Port>, string>} answers what can hold text; split it into a function and a port of methods`
  : ModuleClassifies<Name, Module, Port>;

type ModuleClassifies<Name extends string, Module, Port> = Module extends {
  readonly returnsPersonalData: infer Declared;
}
  ? [Declared] extends [ReturnsPersonalData<Port>]
    ? true
    : `Port ${Name}: returnsPersonalData does not fit the port; type it with satisfies Port.ReturnsPersonalData`
  : [Unclassified<Port>] extends [never]
    ? true
    : `Port ${Name}: ${Unclassified<Port> extends "itself" ? "it answers" : `method ${Extract<Unclassified<Port>, string>} answers`} what can hold text; export returnsPersonalData, saying whose personal data it returns, or false`;
