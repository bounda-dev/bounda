import { create, type Money } from "../money.ts";

export const total = (lines: readonly Money[]): Money =>
  create(
    lines.reduce((sum, line) => sum + line.amount, 0),
    lines[0]?.currency ?? "EUR",
  );
