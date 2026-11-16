import type { Port } from "./+types/email-sender";

export interface EmailSenderArgs {
  readonly template: "welcome" | "activation-reminder";
  readonly userId: string;
  readonly to: string;
  readonly name: string;
  readonly idempotencyKey: string;
}

/**
 * The provider keeps each contact under the user's id, so it can be told about one whose address
 * the app can no longer read.
 */
export interface ContactArgs {
  readonly userId: string;
  readonly idempotencyKey: string;
}

export interface EmailSender {
  send(args: EmailSenderArgs): Promise<void>;
  erase(args: ContactArgs): Promise<void>;
  suppress(args: ContactArgs): Promise<void>;
  resume(args: ContactArgs): Promise<void>;
}

// The provider receives the user's address and name, so it is told when they are forgotten,
// restricted or corrected, and when the whole tenant is forgotten.
export const recipient = {
  name: "Postmark",
  kind: "processor",
  country: "US",
  safeguard: "standard-contractual-clauses",
  categories: ["default"],
} satisfies Port.Recipient;

export const onPersonalDataForgotten = ({
  event,
  emailSender,
  idempotencyKey,
}: Port.OnPersonalDataForgottenArgs) =>
  emailSender.erase({ userId: event.payload.personId, idempotencyKey });

export const onProcessingRestricted = ({
  event,
  emailSender,
  idempotencyKey,
}: Port.OnProcessingRestrictedArgs) =>
  emailSender.suppress({ userId: event.payload.personId, idempotencyKey });

// The user hears of the lift from the app; the provider has nothing to do until it comes.
export const onProcessingRestrictionLiftAnnounced = async (
  _args: Port.OnProcessingRestrictionLiftAnnouncedArgs,
) => {};

export const onProcessingRestrictionLifted = ({
  event,
  emailSender,
  idempotencyKey,
}: Port.OnProcessingRestrictionLiftedArgs) =>
  emailSender.resume({ userId: event.payload.personId, idempotencyKey });

// A corrected address or name reaches the provider with the next email; the old one goes now.
export const onPersonalDataRedacted = ({
  event,
  emailSender,
  idempotencyKey,
}: Port.OnPersonalDataRedactedArgs) =>
  emailSender.erase({ userId: event.payload.personId, idempotencyKey });

// Every user the provider was sent goes, each under a key of its own.
export const onTenantForgotten = async ({
  persons,
  emailSender,
  idempotencyKey,
}: Port.OnTenantForgottenArgs) => {
  for await (const userId of persons()) {
    await emailSender.erase({ userId, idempotencyKey: `${idempotencyKey}:${userId}` });
  }
};
