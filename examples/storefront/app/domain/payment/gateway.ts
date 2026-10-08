export interface CreateIntentArgs {
  readonly paymentId: string;
  readonly orderId: string;
  readonly amount: number;
  readonly idempotencyKey: string;
}

export interface RefundArgs {
  readonly intentId: string;
  readonly amount: number;
  readonly idempotencyKey: string;
}

/**
 * A payment provider in the style of Stripe: an intent is a payment link the customer pays, and
 * the provider tells the app how it went through webhooks. Both calls honour the idempotency key.
 */
export interface Gateway {
  createIntent(args: CreateIntentArgs): Promise<{ readonly intentId: string }>;
  refund(args: RefundArgs): Promise<{ readonly refundId: string }>;
}
