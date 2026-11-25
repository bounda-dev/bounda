import type {
  DeclaredRecipient,
  Disclosure,
  EventStore,
  IdempotencyStore,
  IsRetainedKeyFunction,
  ListRetainedArgs,
  NextRetainedHoldEndArgs,
  PersonalKeyStore,
  PersonsOfArgs,
  ReadByPersonArgs,
  RecipientPort,
  RecipientStore,
  RecipientSummary,
  ResealedSubscriberFailure,
  ResealIdempotencyRecordArgs,
  Storage,
  StorageTransaction,
  StoredDisclosure,
  StoredPersonalKey,
  SubscriberFailureStore,
  SupersedingKey,
} from "@bounda-dev/core/adapter";
import { isRetainedKey } from "@bounda-dev/core/adapter";
import { describe, expectTypeOf, it } from "vitest";

describe("an adapter of your own", () => {
  it("names the recipient store its storage and its transactions hold", () => {
    expectTypeOf<Storage["recipients"]>().toEqualTypeOf<RecipientStore>();
    expectTypeOf<StorageTransaction["recipients"]>().toEqualTypeOf<RecipientStore>();
  });

  it("names every type the recipient store's methods take and give", () => {
    expectTypeOf<RecipientStore["disclose"]>().toEqualTypeOf<
      (disclosures: readonly Disclosure[], at: string) => Promise<readonly Disclosure[]>
    >();
    expectTypeOf<RecipientStore["disclosures"]>().returns.toEqualTypeOf<
      Promise<readonly StoredDisclosure[]>
    >();
    expectTypeOf<RecipientStore["declare"]>().parameters.toEqualTypeOf<
      [ports: readonly RecipientPort[], position: number, at: string]
    >();
    expectTypeOf<RecipientStore["declared"]>().returns.toEqualTypeOf<
      Promise<readonly DeclaredRecipient[]>
    >();
    expectTypeOf<RecipientStore["summary"]>().returns.toEqualTypeOf<
      Promise<readonly RecipientSummary[]>
    >();
    expectTypeOf<RecipientStore["personsOf"]>().parameters.toEqualTypeOf<[args: PersonsOfArgs]>();
    expectTypeOf<StoredDisclosure>().toMatchTypeOf<Disclosure>();
  });

  it("names the arguments and rows of the other stores it implements", () => {
    expectTypeOf<EventStore["readByPerson"]>().parameters.toEqualTypeOf<[args: ReadByPersonArgs]>();
    expectTypeOf<IdempotencyStore["reseal"]>().parameters.toEqualTypeOf<
      [args: ResealIdempotencyRecordArgs]
    >();
    expectTypeOf<PersonalKeyStore["listRetained"]>().parameters.toEqualTypeOf<
      [args: ListRetainedArgs]
    >();
    expectTypeOf<PersonalKeyStore["nextRetainedHoldEnd"]>().parameters.toEqualTypeOf<
      [args: NextRetainedHoldEndArgs]
    >();
    expectTypeOf<PersonalKeyStore["supersede"]>().parameters.toEqualTypeOf<
      [person: string, from: StoredPersonalKey, to: SupersedingKey]
    >();
    expectTypeOf<SubscriberFailureStore["reseal"]>().parameters.toEqualTypeOf<
      [subscriber: string, failure: ResealedSubscriberFailure]
    >();
    expectTypeOf(isRetainedKey).toEqualTypeOf<IsRetainedKeyFunction>();
  });
});
