import type { Policy } from "./+types/index";

export interface WelcomeEmail {
  readonly to: string;
  readonly name: string;
}

export type Collaborators = {
  emailSender: { send: (email: WelcomeEmail, idempotencyKey: string) => Promise<void> };
};

export const handler = async ({
  event,
  commands,
  emailSender,
  idempotencyKey,
}: Policy.HandlerArgs) => {
  await emailSender.send({ to: event.payload.to, name: event.payload.name }, idempotencyKey);
  await commands.recordWelcomeEmailSent({ userId: event.aggregateId, to: event.payload.to });
};
