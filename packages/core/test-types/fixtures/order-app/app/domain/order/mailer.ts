import type { Port } from "./+types/mailer";

export interface Mailer {
  send(to: string, message: string): Promise<void>;
}

export const recipient = {
  name: "Postmark",
  kind: "processor",
  country: "US",
  safeguard: "standard-contractual-clauses",
  categories: ["delivery"],
} satisfies Port.Recipient;

export const onPersonalDataForgotten = async ({
  event,
  categories,
  retained,
  mailer,
}: Port.OnPersonalDataForgottenArgs) => {
  await mailer.send(event.payload.personId, `forget ${categories.join()} keep ${retained.join()}`);
};

export const onProcessingRestricted = async ({
  event,
  mailer,
}: Port.OnProcessingRestrictedArgs) => {
  await mailer.send(event.payload.personId, `restrict ${event.payload.ground}`);
};

export const onProcessingRestrictionLiftAnnounced = async ({
  event,
  mailer,
}: Port.OnProcessingRestrictionLiftAnnouncedArgs) => {
  await mailer.send(event.payload.personId, `lift at ${event.payload.liftsAt}`);
};

export const onProcessingRestrictionLifted = async ({
  event,
  mailer,
}: Port.OnProcessingRestrictionLiftedArgs) => {
  await mailer.send(event.payload.personId, "lifted");
};

export const onPersonalDataRedacted = async ({
  event,
  presumed,
  mailer,
}: Port.OnPersonalDataRedactedArgs) => {
  await mailer.send(event.payload.personId, `redacted, presumed ${String(presumed)}`);
};

export const onTenantForgotten = async ({
  event,
  categories,
  persons,
  mailer,
}: Port.OnTenantForgottenArgs) => {
  for await (const person of persons()) {
    await mailer.send(person, `${event.payload.tenant} forgot ${categories.join(", ")}`);
  }
};
