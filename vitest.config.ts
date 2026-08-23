import { defineConfig } from "vitest/config";

const BROWSER_DRIVEN = [
  "test/parity/browser.test.ts",
  "test/parity/demo-browser.test.ts",
  "test/parity/libcurl-browser.test.ts",
  "test/parity/opfs-browser.test.ts",
  "test/parity/persistence-browser.test.ts",
  "test/parity/testbed.test.ts",
  "test/parity/worker-browser.test.ts",
];

const shared = {
  testTimeout: 60_000,
  hookTimeout: 180_000,
};

export default defineConfig({
  test: {
    coverage: {
      provider: "v8" as const,
      reporter: ["text", "json-summary", "html"],
      include: ["packages/*/src/**/*.ts", "test/contract/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**", "**/*.config.ts", "**/cli/**"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
    projects: [
      {
        test: {
          ...shared,
          name: "unit",
          include: [
            "packages/*/src/**/*.test.ts",
            "packages/*/test/**/*.test.ts",
            "test/contract/src/**/*.test.ts",
            "test/parity/**/*.test.ts",
            "tools/*/src/**/*.test.ts",
          ],
          exclude: ["**/node_modules/**", "**/dist/**", "test/e2e/**", ...BROWSER_DRIVEN],
        },
      },
      {
        test: {
          ...shared,
          name: "browser",
          include: BROWSER_DRIVEN,
          exclude: ["**/node_modules/**", "**/dist/**"],
          fileParallelism: false,
        },
      },
    ],
  },
});
