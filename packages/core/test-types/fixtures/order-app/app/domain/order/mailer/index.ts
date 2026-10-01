export interface Mailer {
  send(to: string, message: string): Promise<void>;
}
