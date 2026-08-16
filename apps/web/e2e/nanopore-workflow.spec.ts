import { expect, test } from "@playwright/test";

test("runs the four-step targeted Nanopore enrichment workflow", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page.getByRole("button", { name: "Nanopore" }).click();
  await page.getByRole("button", { name: "Load demo" }).click();
  await page.getByRole("button", { name: "Continue to Design" }).click();
  await expect(page.getByRole("button", { name: "Continue to Analyze" })).toBeEnabled();
  await page.getByRole("button", { name: "Continue to Analyze" }).click();
  await expect(page.getByRole("heading", { name: "Run targeted Nanopore pipeline" })).toBeVisible();
  await page.getByRole("button", { name: "Run analysis" }).click();
  await expect(page.getByText("Callable target observations")).toBeVisible({ timeout: 150_000 });
  await expect(page.getByRole("heading", { name: "Downloads" })).toBeVisible();
});
