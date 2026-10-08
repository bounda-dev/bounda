export interface NotifierArgs {
  readonly orderId: string;
  readonly customerId: string;
  readonly total: number;
  readonly idempotencyKey: string;
}

export interface Notifier {
  (args: NotifierArgs): Promise<void>;
}
