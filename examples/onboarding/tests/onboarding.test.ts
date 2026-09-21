import { DomainError, ValidationError } from "@bounda-dev/core";
import { createTestApp } from "@bounda-dev/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { registry } from "../.bounda/registry.ts";
import { sent } from "../app/domain/user/commands/send-welcome-email/email-sender.memory.ts";

const ADA = "018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e01";
const GRACE = "018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e02";
const LINUS = "018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e03";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const start = () =>
  createTestApp({
    registry,
    config: { commands: { sendWelcomeEmail: { emailSender: { use: "memory" } } } },
  });

describe("onboarding", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("registers a user, lists it and welcomes it a minute later", async () => {
    const { app, clock } = await start();
    await app.commands.registerUser({ userId: ADA, email: "ada@example.com", name: "Ada" });
    await app.processUntilIdle();

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
    await app.processUntilIdle();
    expect(sent).toEqual([{ to: "ada@example.com", name: "Ada" }]);
    expect(await app.queries.getUserDetails({ userId: ADA })).toMatchObject({
      welcomeEmailSentAt: expect.any(Date),
    });
    expect((await app.getLag()).maxLag).toBe(0);
    await app.stop();
  });

  it("completes the process on activation, so the registration never expires", async () => {
    const { app, clock } = await start();
    await app.commands.registerUser({ userId: ADA, email: "ada@example.com", name: "Ada" });
    await app.commands.activateUser({ userId: ADA });
    await app.processUntilIdle();

    clock.advance(8 * DAY);
    await app.processUntilIdle();
    const details = await app.queries.getUserDetails({ userId: ADA });
    expect(details).toMatchObject({ status: "active", activatedAt: expect.any(Date) });
    expect(details?.expiredAt).toBeUndefined();
    expect(sent).toEqual([{ to: "ada@example.com", name: "Ada" }]);
    await app.stop();
  });

  it("expires a registration nobody activates within a week", async () => {
    const { app, clock } = await start();
    await app.commands.registerUser({ userId: ADA, email: "ada@example.com", name: "Ada" });
    await app.processUntilIdle();

    clock.advance(7 * DAY - MINUTE);
    await app.processUntilIdle();
    expect(await app.queries.getUserDetails({ userId: ADA })).toMatchObject({
      status: "registered",
    });

    clock.advance(MINUTE);
    await app.processUntilIdle();
    expect(await app.queries.getUserDetails({ userId: ADA })).toMatchObject({
      status: "expired",
      expiredAt: expect.any(Date),
    });
    await expect(app.commands.activateUser({ userId: ADA })).rejects.toThrow(DomainError);
    await app.stop();
  });

  it("rejects duplicate registrations and invalid payloads", async () => {
    const { app } = await start();
    await app.commands.registerUser({ userId: ADA, email: "ada@example.com", name: "Ada" });
    await expect(
      app.commands.registerUser({ userId: ADA, email: "ada@example.com", name: "Ada" }),
    ).rejects.toThrow(DomainError);
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
    await app.processUntilIdle();

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
    await app.processUntilIdle();

    const first = await app.queries.listUsers({ page: 1, pageSize: 2 });
    expect(first).toMatchObject({ total: 3, active: 1, page: 1, pageSize: 2, pages: 2 });
    expect(first.users.map((user) => user.name)).toEqual(["Linus", "Grace"]);

    const second = await app.queries.listUsers({ page: 2, pageSize: 2 });
    expect(second.users.map((user) => user.name)).toEqual(["Ada"]);
    await app.stop();
  });
});
