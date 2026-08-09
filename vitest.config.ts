import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "test/contract/src/**/*.test.ts",
      "test/parity/**/*.test.ts",
      "tools/*/src/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "test/e2e/**"],
    coverage: {
      provider: "v8",
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
  },
});
