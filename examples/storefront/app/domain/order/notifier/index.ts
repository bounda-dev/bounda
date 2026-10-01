export interface Confirmation {
  readonly orderId: string;
  readonly customerId: string;
  readonly total: number;
}

export type Notifier = (confirmation: Confirmation, idempotencyKey: string) => Promise<void>;
