import { expect, test } from "@playwright/test";

test("places an order and lists it", async ({ page }) => {
  const tenant = `smoke-${Date.now()}`;
  await page.goto("/");
  await page.getByLabel("Tenant").fill(tenant);
  await page.getByLabel("Customer").fill("ada");
  await page.getByLabel("Total").fill("42");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByText("Stored as version 1.")).toBeVisible();
  await expect(page.getByText("ada: 1 order(s), 42 in total")).toBeVisible();
});
