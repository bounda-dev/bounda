import type {
  NotifiesRecipient,
  PersonalCategoryName,
  PersonalDataForgottenEvent,
  PersonalDataRedactedEvent,
  ProcessingRestrictedEvent,
  ProcessingRestrictionLiftAnnouncedEvent,
  ProcessingRestrictionLiftedEvent,
  RecipientDeclaration,
  RecipientModule,
  Registry,
} from "@bounda-dev/core";
import { describe, expectTypeOf, it } from "vitest";
import type { registry } from "./fixtures/order-app/.bounda/registry.ts";
import type { OrderRecipients } from "./fixtures/order-app/.bounda/types.ts";
import type { Port } from "./fixtures/order-app/app/domain/order/+types/mailer.ts";
import type * as mailer from "./fixtures/order-app/app/domain/order/mailer.ts";

describe("recipients", () => {
  it("types a port's recipient with the app's categories, and its transfer by its country", () => {
    expectTypeOf<Port.Recipient>().toEqualTypeOf<RecipientDeclaration>();
    expectTypeOf<Port.Recipient["categories"][number]>().toEqualTypeOf<PersonalCategoryName>();
    expectTypeOf<typeof mailer.recipient>().toExtend<Port.Recipient>();
    const inside = {
      name: "Brevo",
      kind: "processor",
      country: "FR",
      categories: ["delivery"],
    } as const;
    expectTypeOf(inside).toExtend<Port.Recipient>();
    const outside = { ...inside, country: "US" } as const;
    // @ts-expect-error a transfer out of the EEA names its safeguard
    void (outside satisfies Port.Recipient);
    // @ts-expect-error one within it takes none
    void ({ ...inside, safeguard: "adequacy" } as const satisfies Port.Recipient);
    // @ts-expect-error a category the app does not declare
    void ({ ...inside, categories: ["marketing"] } as const satisfies Port.Recipient);
    // @ts-expect-error a kind the GDPR does not name
    void ({ ...inside, kind: "partner" } as const satisfies Port.Recipient);
    // @ts-expect-error a country that is no ISO 3166-1 code
    void ({ ...inside, country: "XX" } as const satisfies Port.Recipient);
    // @ts-expect-error a recipient receives some category
    void ({ ...inside, categories: [] } as const satisfies Port.Recipient);
  });

  it("types each handler with its event, what concerns the recipient and the port", () => {
    expectTypeOf<
      Port.OnPersonalDataForgottenArgs["event"]
    >().toEqualTypeOf<PersonalDataForgottenEvent>();
    expectTypeOf<Port.OnPersonalDataForgottenArgs["retained"]>().toEqualTypeOf<
      readonly PersonalCategoryName[]
    >();
    expectTypeOf<
      Port.OnProcessingRestrictedArgs["event"]
    >().toEqualTypeOf<ProcessingRestrictedEvent>();
    expectTypeOf<
      Port.OnProcessingRestrictionLiftAnnouncedArgs["event"]
    >().toEqualTypeOf<ProcessingRestrictionLiftAnnouncedEvent>();
    expectTypeOf<
      Port.OnProcessingRestrictionLiftedArgs["event"]
    >().toEqualTypeOf<ProcessingRestrictionLiftedEvent>();
    expectTypeOf<
      Port.OnPersonalDataRedactedArgs["event"]
    >().toEqualTypeOf<PersonalDataRedactedEvent>();
    expectTypeOf<Port.OnPersonalDataRedactedArgs["categories"]>().toEqualTypeOf<
      readonly PersonalCategoryName[]
    >();
    expectTypeOf<Port.OnPersonalDataRedactedArgs["presumed"]>().toEqualTypeOf<boolean>();
    expectTypeOf<Port.OnPersonalDataRedactedArgs["idempotencyKey"]>().toEqualTypeOf<string>();
    expectTypeOf<Port.OnPersonalDataRedactedArgs["signal"]>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<Port.OnPersonalDataRedactedArgs["mailer"]>().toEqualTypeOf<mailer.Mailer>();
    expectTypeOf<Port.OnPersonalDataRedactedArgs>().not.toHaveProperty("retained");
    expectTypeOf<Port.OnPersonalDataRedactedArgs>().not.toHaveProperty("commands");
  });

  it("checks in the registry and in .bounda/types.ts that a recipient's port module is whole", () => {
    expectTypeOf<
      (typeof registry)["aggregates"]["order"]["recipients"]["mailer"]
    >().toExtend<RecipientModule>();
    expectTypeOf<Registry["aggregates"][string]["recipients"]>().toEqualTypeOf<
      Readonly<Record<string, RecipientModule>> | undefined
    >();
    expectTypeOf<OrderRecipients>().toEqualTypeOf<[true]>();
    const handlers = {
      onPersonalDataForgotten: () => {},
      onProcessingRestricted: () => {},
      onProcessingRestrictionLiftAnnounced: () => {},
      onProcessingRestrictionLifted: () => {},
      onPersonalDataRedacted: () => {},
    };
    interface Async {
      send(): Promise<void>;
    }
    interface Sync {
      send(): Promise<void>;
      format(): string;
    }
    const { onPersonalDataRedacted: _, ...withoutRedacted } = handlers;
    expectTypeOf<
      NotifiesRecipient<"order.mailer", { recipient: unknown } & typeof handlers, Async>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      NotifiesRecipient<"order.mailer", { recipient: unknown } & typeof withoutRedacted, Async>
    >().toEqualTypeOf<"Port order.mailer declares a recipient, so it exports onPersonalDataRedacted, which tells it of PersonalDataRedacted">();
    expectTypeOf<
      NotifiesRecipient<"order.mailer", { recipient: unknown } & typeof handlers, Sync>
    >().toEqualTypeOf<"Port order.mailer declares a recipient, so its method format must return a promise">();
    expectTypeOf<NotifiesRecipient<"order.mailer", object, Sync>>().toEqualTypeOf<true>();
  });
});
