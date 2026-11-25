// The part of Stryker's mutation testing report (mutation-testing-report-schema) these scripts
// read; every other field passes through untouched.
export interface Position {
  readonly line: number;
  readonly column: number;
}

export interface MutantResult {
  readonly status: string;
  readonly coveredBy?: readonly string[];
  readonly killedBy?: readonly string[];
  readonly [field: string]: unknown;
}

export interface FileResult {
  readonly source: string;
  readonly mutants: readonly MutantResult[];
  readonly [field: string]: unknown;
}

export interface TestDefinition {
  readonly id: string;
  readonly name: string;
  readonly location?: { readonly start: Position };
  readonly [field: string]: unknown;
}

export interface TestFile {
  readonly source?: string;
  readonly tests: readonly TestDefinition[];
  readonly [field: string]: unknown;
}

export interface Report {
  readonly files: Readonly<Record<string, FileResult>>;
  readonly testFiles?: Readonly<Record<string, TestFile>>;
  readonly [field: string]: unknown;
}

export interface Score {
  readonly score: number;
  readonly detected: number;
  readonly valid: number;
  readonly survived: number;
  readonly noCoverage: number;
}

export interface ScoreFunction {
  (report: Report): Score;
}

// The score Stryker reports: detected mutants over those the tests could have detected.
export const scoreOf: ScoreFunction = (report) => {
  const count = new Map<string, number>();
  for (const { mutants } of Object.values(report.files)) {
    for (const { status } of mutants) count.set(status, (count.get(status) ?? 0) + 1);
  }
  const of = (status: string): number => count.get(status) ?? 0;
  const detected = of("Killed") + of("Timeout");
  const valid = detected + of("Survived") + of("NoCoverage");
  return {
    score: valid === 0 ? 100 : (detected / valid) * 100,
    detected,
    valid,
    survived: of("Survived"),
    noCoverage: of("NoCoverage"),
  };
};
