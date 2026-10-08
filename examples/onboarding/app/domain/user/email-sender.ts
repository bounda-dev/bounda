export interface EmailSenderArgs {
  readonly to: string;
  readonly name: string;
  readonly idempotencyKey: string;
}

export interface EmailSender {
  (args: EmailSenderArgs): Promise<void>;
}
