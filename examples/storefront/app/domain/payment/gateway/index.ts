export interface Intent {
  readonly paymentId: string;
  readonly orderId: string;
  readonly amount: number;
}

export interface Refund {
  readonly intentId: string;
  readonly amount: number;
}

/**
 * A payment provider in the style of Stripe: an intent is a payment link the customer pays, and
 * the provider tells the app how it went through webhooks. Both calls honour the idempotency key.
 */
export interface Gateway {
  createIntent(intent: Intent, idempotencyKey: string): Promise<{ readonly intentId: string }>;
  refund(refund: Refund, idempotencyKey: string): Promise<{ readonly refundId: string }>;
}
