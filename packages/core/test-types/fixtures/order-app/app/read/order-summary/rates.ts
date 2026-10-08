export interface RatesArgs {
  readonly from: string;
  readonly to: string;
}

export interface Rates {
  (args: RatesArgs): Promise<number>;
}
