export interface CallCounter {
  /**
   * `target` with every function reached through its properties, `depth` objects deep, counting
   * its calls. What a call returns is handed back as it is.
   */
  count<T extends object>(target: T, depth: number): T;
  /**
   * How many calls were made through every target counted so far.
   */
  calls(): number;
}

export interface CreateCallCounterFunction {
  (): CallCounter;
}

/**
 * What tells a reader whether it read anything since it last looked, without knowing where it
 * reads: the stores it reads through, counting their calls.
 */
export const createCallCounter: CreateCallCounterFunction = () => {
  let calls = 0;
  const counted = (value: unknown, left: number): unknown => {
    if (typeof value !== "object" || value === null || left === 0) return value;
    return new Proxy(value, {
      get: (object, property) => {
        const found: unknown = Reflect.get(object, property);
        if (typeof found !== "function") return counted(found, left - 1);
        return (...args: unknown[]) => {
          calls += 1;
          return Reflect.apply(found, object, args);
        };
      },
    });
  };
  return {
    count: <T extends object>(target: T, depth: number) => counted(target, depth) as T,
    calls: () => calls,
  };
};
