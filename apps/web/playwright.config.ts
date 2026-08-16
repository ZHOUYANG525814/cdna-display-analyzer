import { defineConfig, devices } from "@playwright/test";
import { webkit } from "@playwright/test";
import { dirname, join } from "node:path";

const extraWebkitLib = process.env.PLAYWRIGHT_EXTRA_LIB_PATH;
const webkitRoot = dirname(webkit.executablePath());
const bundledWebkit = join(webkitRoot, "minibrowser-wpe");
const webkitLaunch = extraWebkitLib ? {
  executablePath: join(bundledWebkit, "bin", "MiniBrowser"),
  env: {
    ...process.env,
    LD_LIBRARY_PATH: [
      extraWebkitLib,
      join(bundledWebkit, "lib"),
      join(bundledWebkit, "sys", "lib"),
    ].join(":"),
    WEBKIT_EXEC_PATH: join(bundledWebkit, "bin"),
    WEBKIT_INJECTED_BUNDLE_PATH: join(bundledWebkit, "lib"),
    WEBKIT_INSPECTOR_RESOURCES_PATH: join(bundledWebkit, "share"),
  },
} : undefined;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results/playwright",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["json", { outputFile: "test-results/playwright/results.json" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm build && pnpm preview --host 127.0.0.1 --port 4173",
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"], ...(webkitLaunch ? { launchOptions: webkitLaunch } : {}) } },
  ],
});
