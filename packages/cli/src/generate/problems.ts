/**
 * One thing in the project that breaks a convention, with the file or directory it is about.
 */
export interface Problem {
  readonly path: string;
  readonly message: string;
}

/**
 * Thrown by discovery when the project layout breaks a convention. Every problem is collected
 * before throwing, so one run reports them all.
 */
export class ConventionError extends Error {
  readonly problems: readonly Problem[];

  constructor(problems: readonly Problem[]) {
    super(
      [
        `${problems.length === 1 ? "1 problem" : `${problems.length} problems`} in the project layout:`,
        ...problems.map((problem) => `  ${problem.path}: ${problem.message}`),
      ].join("\n"),
    );
    this.name = "ConventionError";
    this.problems = problems;
  }
}

export interface ProblemCollector {
  add(path: string, message: string): void;
  throwIfAny(): void;
  readonly problems: readonly Problem[];
}

export interface CreateProblemCollectorFunction {
  (): ProblemCollector;
}

export const createProblemCollector: CreateProblemCollectorFunction = () => {
  const problems: Problem[] = [];
  return {
    problems,
    add: (path, message) => {
      problems.push({ path, message });
    },
    throwIfAny: () => {
      if (problems.length > 0) throw new ConventionError([...problems]);
    },
  };
};
