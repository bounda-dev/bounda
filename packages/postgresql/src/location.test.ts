import { describe, expect, it } from "vitest";
import { postgresql } from "./index.ts";

describe("postgresql's location", () => {
  it("declares where the server keeps its data when told, and nothing otherwise", () => {
    expect(postgresql({ url: "postgres://db.example/app", location: "eu" }).location).toBe("eu");
    expect(
      postgresql({ host: "db.example", database: "app", user: "app", location: "eu" }).location,
    ).toBe("eu");
    expect(postgresql({ url: "postgres://db.example/app" })).not.toHaveProperty("location");
    // @ts-expect-error a location is a jurisdiction's name, such as "eu"
    const refused = () => postgresql({ url: "postgres://db.example/app", location: 7 });
    expect(refused).toBeTypeOf("function");
  });
});
