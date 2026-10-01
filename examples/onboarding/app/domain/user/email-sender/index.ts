export interface WelcomeEmail {
  readonly to: string;
  readonly name: string;
}

export interface EmailSender {
  send(email: WelcomeEmail, idempotencyKey: string): Promise<void>;
}
