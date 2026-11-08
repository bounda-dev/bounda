import { DomainError, ValidationError } from "@bounda-dev/core";
import { createTestApp } from "@bounda-dev/core/testing";
import { describe, expect, it } from "vitest";
import { registry } from "../.bounda/registry.ts";
import type { EmailSenderArgs } from "../app/domain/user/email-sender.ts";

const ADA = "018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e01";
const GRACE = "018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e02";
const LINUS = "018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e03";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * Each test gets its own email sender, which records what it was asked to send.
 */
const start = async () => {
  const sent: EmailSenderArgs[] = [];
  const test = await createTestApp({
    registry,
    ports: { user: { emailSender: async (email) => void sent.push(email) } },
  });
  return { ...test, sent };
};

describe("onboarding", () => {
  it("registers a user, lists it and welcomes it a minute later", async () => {
    const { app, clock, sent } = await start();
    await app.commands.registerUser({ userId: ADA, email: "ada@example.com", name: "Ada" });
    await app.runUntilIdle();

    expect(await app.queries.listUsers({})).toMatchObject({
      total: 1,
      active: 0,
      page: 1,
      pages: 1,
      users: [{ userId: ADA, email: "ada@example.com", name: "Ada", status: "registered" }],
    });
    expect(sent).toEqual([]);
    expect((await app.queries.getUserDetails({ userId: ADA }))?.welcomeEmailSentAt).toBeUndefined();

    clock.advance(MINUTE);
    await app.runUntilIdle();
    expect(sent).toEqual([
      {
        template: "welcome",
        to: "ada@example.com",
        name: "Ada",
        idempotencyKey: expect.any(String),
      },
    ]);
    expect(await app.queries.getUserDetails({ userId: ADA })).toMatchObject({
      welcomeEmailSentAt: expect.any(Date),
    });
    expect((await app.getLag()).maxLag).toBe(0);
    await app.stop();
  });

  it("completes the process on activation, so the registration never expires", async () => {
    const { app, clock, sent } = await start();
    await app.commands.registerUser({ userId: ADA, email: "ada@example.com", name: "Ada" });
    await app.commands.activateUser({ userId: ADA });
    await app.runUntilIdle();

    clock.advance(8 * DAY);
    await app.runUntilIdle();
    const details = await app.queries.getUserDetails({ userId: ADA });
    expect(details).toMatchObject({ status: "active", activatedAt: expect.any(Date) });
    expect(details?.expiredAt).toBeUndefined();
    expect(sent).toEqual([
      {
        template: "welcome",
        to: "ada@example.com",
        name: "Ada",
        idempotencyKey: expect.any(String),
      },
    ]);
    await app.stop();
  });

  it("expires a registration nobody activates within a week", async () => {
    const { app, clock } = await start();
    await app.commands.registerUser({ userId: ADA, email: "ada@example.com", name: "Ada" });
    await app.runUntilIdle();

    clock.advance(7 * DAY - MINUTE);
    await app.runUntilIdle();
    expect(await app.queries.getUserDetails({ userId: ADA })).toMatchObject({
      status: "registered",
    });

    clock.advance(MINUTE);
    await app.runUntilIdle();
    expect(await app.queries.getUserDetails({ userId: ADA })).toMatchObject({
      status: "expired",
      expiredAt: expect.any(Date),
    });
    await expect(app.commands.activateUser({ userId: ADA })).rejects.toMatchObject({
      rejected: "Expired",
    });
    await app.stop();
  });

  it("reminds a user who has not activated three days later, once", async () => {
    const { app, clock, sent } = await start();
    await app.commands.registerUser({ userId: ADA, email: "ada@example.com", name: "Ada" });
    await app.commands.registerUser({ userId: GRACE, email: "grace@example.com", name: "Grace" });
    await app.commands.activateUser({ userId: GRACE });
    await app.runUntilIdle();

    clock.advance(3 * DAY);
    await app.runUntilIdle();
    expect(sent.filter((email) => email.template === "activation-reminder")).toEqual([
      {
        template: "activation-reminder",
        to: "ada@example.com",
        name: "Ada",
        idempotencyKey: expect.any(String),
      },
    ]);
    await app.stop();
  });

  it("forgets a user: their rows go, for good, and their reminder is cancelled", async () => {
    const { app, clock, sent } = await start();
    await app.commands.registerUser({ userId: ADA, email: "ada@example.com", name: "Ada" });
    await app.commands.registerUser({ userId: GRACE, email: "grace@example.com", name: "Grace" });
    clock.advance(MINUTE);
    await app.runUntilIdle();
    await app.commands.updateProfile({ userId: ADA, name: "Ada Lovelace" });

    await app.forget(ADA);
    await app.runUntilIdle();
    expect(await app.queries.getUserDetails({ userId: ADA })).toBeNull();
    expect((await app.queries.listUsers({})).users.map((user) => user.name)).toEqual(["Grace"]);
    const [forgotten] = (await app.events.read()).filter(
      (event) => event.type === "PersonalDataForgotten",
    );
    expect(forgotten?.payload).toMatchObject({
      personId: ADA,
      cancelledCommands: [{ type: "SendActivationReminder" }],
    });

    clock.advance(3 * DAY);
    await app.runUntilIdle();
    expect(sent.map((email) => [email.template, email.to])).toEqual([
      ["welcome", "ada@example.com"],
      ["welcome", "grace@example.com"],
      ["activation-reminder", "grace@example.com"],
    ]);

    // A rebuild replays Ada's events with her fields read as null, and leaves her out again.
    await app.rebuildReadModel("usersDirectory");
    await app.rebuildReadModel("userDetails");
    expect((await app.queries.listUsers({})).users.map((user) => user.name)).toEqual(["Grace"]);
    expect(await app.queries.getUserDetails({ userId: ADA })).toBeNull();
    await app.stop();
  });

  it("keeps who registered and who activated a user, and what their requests caused", async () => {
    const { app, clock } = await start();
    await app.as("support-1").commands.registerUser({
      userId: ADA,
      email: "ada@example.com",
      name: "Ada",
    });
    await app.commands.registerUser({ userId: GRACE, email: "grace@example.com", name: "Grace" });
    await app.as("support-2").commands.activateUser({ userId: ADA });
    clock.advance(MINUTE);
    await app.runUntilIdle();

    expect(await app.queries.getUserDetails({ userId: ADA })).toMatchObject({
      registeredBy: "support-1",
      activatedBy: "support-2",
    });
    const grace = await app.queries.getUserDetails({ userId: GRACE });
    expect(grace?.registeredBy).toBeUndefined();
    expect(grace?.activatedBy).toBeUndefined();
    const welcome = (await app.events.read({ limit: 100 })).find(
      (event) => event.type === "WelcomeEmailSent" && event.aggregateId === ADA,
    );
    expect(welcome?.metadata.actor).toBe("support-1");
    await app.stop();
  });

  it("rejects duplicate registrations and invalid payloads", async () => {
    const { app } = await start();
    await app.commands.registerUser({ userId: ADA, email: "ada@example.com", name: "Ada" });
    await expect(
      app.commands.registerUser({ userId: ADA, email: "ada@example.com", name: "Ada" }),
    ).rejects.toThrow(DomainError);
    await expect(
      app.commands.registerUser({ userId: ADA, email: "ada@example.com", name: "Ada" }),
    ).rejects.toMatchObject({ rejected: "AlreadyRegistered" });
    await expect(
      app.commands.registerUser({ userId: GRACE, email: "not-an-email", name: "" }),
    ).rejects.toThrow(ValidationError);
    await expect(app.commands.activateUser({ userId: GRACE })).rejects.toThrow("does not exist");
    await app.stop();
  });

  it("renames a user in both read models and ignores a rename to the same name", async () => {
    const { app } = await start();
    await app.commands.registerUser({ userId: ADA, email: "ada@example.com", name: "Ada" });
    await app.commands.updateProfile({ userId: ADA, name: "Ada Lovelace" });
    await app.commands.updateProfile({ userId: ADA, name: "Ada Lovelace" });
    await app.runUntilIdle();

    expect(await app.queries.getUserDetails({ userId: ADA })).toMatchObject({
      name: "Ada Lovelace",
    });
    expect((await app.queries.listUsers({})).users).toMatchObject([{ name: "Ada Lovelace" }]);
    await app.stop();
  });

  it("pages the directory, newest first", async () => {
    const { app, clock } = await start();
    await app.commands.registerUser({ userId: ADA, email: "ada@example.com", name: "Ada" });
    clock.advance(MINUTE);
    await app.commands.registerUser({ userId: GRACE, email: "grace@example.com", name: "Grace" });
    clock.advance(MINUTE);
    await app.commands.registerUser({ userId: LINUS, email: "linus@example.com", name: "Linus" });
    await app.commands.activateUser({ userId: GRACE });
    await app.runUntilIdle();

    const first = await app.queries.listUsers({ page: 1, pageSize: 2 });
    expect(first).toMatchObject({ total: 3, active: 1, page: 1, pageSize: 2, pages: 2 });
    expect(first.users.map((user) => user.name)).toEqual(["Linus", "Grace"]);

    const second = await app.queries.listUsers({ page: 2, pageSize: 2 });
    expect(second.users.map((user) => user.name)).toEqual(["Ada"]);
    await app.stop();
  });
});
