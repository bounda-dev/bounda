export interface Money {
  readonly amount: number;
  readonly currency: string;
}

export const create = (amount: number, currency: string): Money => ({ amount, currency });
