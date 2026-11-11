import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

// @kirocrew/app-sdk is provided by the host and is not on npm: tests render against small stand-ins.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@kirocrew\/app-sdk\/ui$/, replacement: path.join(here, "test/stubs/app-sdk-ui.tsx") },
      { find: /^@kirocrew\/app-sdk$/, replacement: path.join(here, "test/stubs/app-sdk.ts") },
    ],
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
