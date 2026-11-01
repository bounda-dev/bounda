import { describe, expect, it } from "vitest";
import { createIdempotencyKey, IdempotencyKeyField, renewOnInput } from "./form.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const fieldIn = (form: EventTarget | null, value = "k-1") =>
  ({ form, value }) as unknown as HTMLInputElement;

describe("createIdempotencyKey", () => {
  it("makes a new UUID every time", () => {
    const key = createIdempotencyKey();
    expect(key).toMatch(UUID);
    expect(createIdempotencyKey()).not.toBe(key);
  });
});

describe("IdempotencyKeyField", () => {
  it("renders a hidden idempotencyKey field holding the loader's key, remounted when it changes", () => {
    const field = IdempotencyKeyField({ value: "k-1" });
    expect(field.type).toBe("input");
    expect(field.key).toBe("k-1");
    expect(field.props).toEqual({
      ref: renewOnInput,
      type: "hidden",
      name: "idempotencyKey",
      defaultValue: "k-1",
    });
  });
});

describe("renewOnInput", () => {
  it("gives the field a fresh key whenever the form is edited, until it unmounts", () => {
    const form = new EventTarget();
    const input = fieldIn(form);
    const cleanup = renewOnInput(input);
    expect(input.value).toBe("k-1");

    form.dispatchEvent(new Event("input"));
    const renewed = input.value;
    expect(renewed).toMatch(UUID);
    form.dispatchEvent(new Event("input"));
    expect(input.value).not.toBe(renewed);

    cleanup();
    const last = input.value;
    form.dispatchEvent(new Event("input"));
    expect(input.value).toBe(last);
  });

  it("does nothing for a field outside a form", () => {
    const input = fieldIn(null);
    expect(() => renewOnInput(input)()).not.toThrow();
    expect(input.value).toBe("k-1");
  });
});
