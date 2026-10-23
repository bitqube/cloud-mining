import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  // Integration tests share one database; run files one at a time.
  test: { fileParallelism: false },
});
