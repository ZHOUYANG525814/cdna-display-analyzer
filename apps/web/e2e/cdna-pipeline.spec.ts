import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";

test("runs a 10k-read gzip multi-shard cDNA job end to end", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/");
  await page.getByRole("button", { name: /Try with demo data/ }).click();
  await expect(page.getByText(/Demo data loaded/)).toBeVisible();
  await page.getByRole("button", { name: "Clear all" }).click();

  const fixture = await readFile(resolve(import.meta.dirname, "../../../packages/core/test/fixtures/sample_1k.fastq"), "utf8");
  const lines = fixture.trimEnd().split("\n");
  const midpoint = Math.floor(lines.length / 8) * 4;
  const firstHalf = lines.slice(0, midpoint).join("\n") + "\n";
  const secondHalf = lines.slice(midpoint).join("\n") + "\n";
  const shardA = gzipSync(Buffer.from(firstHalf.repeat(10)));
  const shardB = gzipSync(Buffer.from(secondHalf.repeat(10)));
  await page.locator('input[type="file"][multiple]').setInputFiles([
    { name: "shard-a.fastq.gz", mimeType: "application/gzip", buffer: shardA },
    { name: "shard-b.fastq.gz", mimeType: "application/gzip", buffer: shardB },
  ]);
  await expect(page.getByText("shard-a.fastq.gz")).toBeVisible();
  await expect(page.getByText("shard-b.fastq.gz")).toBeVisible();

  await page.getByRole("button", { name: /^Continue$/ }).click();
  await page.getByRole("button", { name: /Continue to Preview/ }).click();
  await expect(page.getByRole("button", { name: /Continue to Run/ })).toBeEnabled();
  await page.getByRole("button", { name: /Continue to Run/ }).click();
  await page.getByRole("button", { name: /^Start$/ }).click();
  await expect(page.getByRole("heading", { name: "Downloads" })).toBeVisible({ timeout: 240_000 });
  await expect(page.getByText("10,000", { exact: true }).first()).toBeVisible();
});

test("can cancel a cDNA worker and run again with the same gzip shards", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/");
  await page.getByRole("button", { name: /Try with demo data/ }).click();
  await expect(page.getByText(/Demo data loaded/)).toBeVisible();
  await page.getByRole("button", { name: "Clear all" }).click();

  const fixture = await readFile(resolve(import.meta.dirname, "../../../packages/core/test/fixtures/sample_1k.fastq"), "utf8");
  const compressed = gzipSync(Buffer.from(fixture.repeat(10)));
  await page.locator('input[type="file"][multiple]').setInputFiles([
    { name: "rerun.fastq.gz", mimeType: "application/gzip", buffer: compressed },
  ]);
  await page.getByRole("button", { name: /^Continue$/ }).click();
  await page.getByRole("button", { name: /Continue to Preview/ }).click();
  await page.getByRole("button", { name: /Continue to Run/ }).click();

  await page.getByRole("button", { name: /^Start$/ }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Cancelled.")).toBeVisible();
  await page.getByRole("button", { name: "Run again" }).click();
  await expect(page.getByRole("heading", { name: "Downloads" })).toBeVisible({ timeout: 240_000 });
  await expect(page.getByText("10,000", { exact: true }).first()).toBeVisible();
});
