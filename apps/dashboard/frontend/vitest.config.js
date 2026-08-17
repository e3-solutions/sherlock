import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";

import viteConfig from "./vite.config.js";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.{js,jsx}", "../src/server/**/*.test.js"],
      setupFiles: ["./src/test-setup.js"],
      restoreMocks: true,
      clearMocks: true,
    },
  }),
);
