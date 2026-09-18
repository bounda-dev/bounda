import { v7 as uuidV7 } from "uuid";

/**
 * Produces the identifiers the runtime assigns to events, commands and executions. The default
 * generates UUID v7, which sorts by creation time.
 */
export interface IdGenerator {
  next(): string;
}

/**
 * The default generator: time-ordered UUID v7.
 */
export const uuidV7IdGenerator: IdGenerator = {
  next: () => uuidV7(),
};

export interface CreateSequentialIdGeneratorArgs {
  readonly prefix?: string;
}

export interface CreateSequentialIdGeneratorFunction {
  (args?: CreateSequentialIdGeneratorArgs): IdGenerator;
}

/**
 * A deterministic generator for tests: `prefix-1`, `prefix-2`, and so on.
 */
export const createSequentialIdGenerator: CreateSequentialIdGeneratorFunction = ({
  prefix = "id",
} = {}) => {
  let counter = 0;
  return {
    next: () => {
      counter += 1;
      return `${prefix}-${counter}`;
    },
  };
};
