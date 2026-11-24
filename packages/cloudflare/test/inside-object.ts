import { runInDurableObject } from "cloudflare:test";

const isPort = (value: unknown): value is object =>
  typeof value === "object" &&
  value !== null &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.values(value).some((member) => typeof member === "function");

// Members that touch no storage and answer at once, as their callers expect: run where they are,
// and what they hand out wrapped as the adapter's own, as `Storage.forgotten` hands out stores.
const SYNCHRONOUS: ReadonlySet<PropertyKey> = new Set(["condition", "forgotten"]);

/**
 * Wraps what an adapter hands out inside a Durable Object so that code outside it can use it: a
 * Durable Object's storage only answers calls made from the object's own context, so every method
 * call runs there through `runInDurableObject`, and every port it returns is wrapped the same way.
 * Rows and other plain values pass through untouched.
 */
export const insideObject = <T>(stub: DurableObjectStub, value: T): T => {
  if (!isPort(value)) return value;
  return new Proxy(value, {
    get: (target, property, receiver) => {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof member !== "function") return insideObject(stub, member);
      if (SYNCHRONOUS.has(property)) {
        return (...args: unknown[]) => insideObject(stub, Reflect.apply(member, target, args));
      }
      return async (...args: unknown[]) =>
        insideObject(
          stub,
          await runInDurableObject(stub, () => Reflect.apply(member, target, args) as unknown),
        );
    },
  });
};
