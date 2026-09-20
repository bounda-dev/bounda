import { relative } from "node:path";
import type { GenerateReport } from "./generate/generate.ts";
import type { ConventionError } from "./generate/problems.ts";

const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralForm}`;

const display = (root: string, path: string): string => relative(root, path).split("\\").join("/");

export interface FormatReportArgs {
  readonly report: GenerateReport;
  readonly root: string;
}

export interface FormatReportFunction {
  (args: FormatReportArgs): string;
}

/**
 * What `bounda generate` prints on success: one line per file written or removed, then one
 * summary line. Unchanged files are not listed.
 */
export const formatReport: FormatReportFunction = ({ report, root }) => {
  const lines = [
    ...report.written.map((path) => `  written  ${display(root, path)}`),
    ...report.removed.map((path) => `  removed  ${display(root, path)}`),
  ];
  const summary = [
    plural(report.model.aggregates.length, "aggregate"),
    plural(report.model.readModels.length, "read model"),
    `${plural(report.files.length, "file")} (${report.written.length} written, ${report.unchanged.length} unchanged, ${report.removed.length} removed)`,
  ].join(", ");
  return [...lines, summary].join("\n");
};

export interface FormatWarningsFunction {
  (report: GenerateReport): string;
}

/**
 * One line per inference warning, for stderr. Empty when there is nothing to say.
 */
export const formatWarnings: FormatWarningsFunction = (report) =>
  report.warnings.map((warning) => `warning: ${warning.aggregate}: ${warning.message}`).join("\n");

export interface FormatConventionErrorArgs {
  readonly error: ConventionError;
  readonly root: string;
}

export interface FormatConventionErrorFunction {
  (args: FormatConventionErrorArgs): string;
}

/**
 * Every convention problem with its path relative to the project root.
 */
export const formatConventionError: FormatConventionErrorFunction = ({ error, root }) =>
  [
    `error: ${plural(error.problems.length, "problem")} in the project layout`,
    ...error.problems.map((problem) => `  ${display(root, problem.path)}: ${problem.message}`),
  ].join("\n");
