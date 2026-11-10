import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "vendor/irc-protocol/test/**/*.test.ts"],
    environment: "node",
  },
});
