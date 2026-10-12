import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";

import viteConfig from "./vite.config.js";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      // Database fixtures change shared roles/RLS in rolled-back transactions.
      // Parallel files can deadlock against unrelated fixture readers.
      fileParallelism: !process.env.SHERLOCK_TEST_DATABASE_URL,
      include: ["src/**/*.test.{js,jsx}", "../src/server/**/*.test.js"],
      setupFiles: ["./src/test-setup.js"],
      restoreMocks: true,
      clearMocks: true,
    },
  }),
);
