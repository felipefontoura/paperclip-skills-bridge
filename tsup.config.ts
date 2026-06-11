import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  shims: false,
  // The shebang `#!/usr/bin/env node` is already at the top of src/server.ts
  // and tsup preserves it — no `banner` override needed (it would double-up).
  // Keep the shebang exec bit when emitting `bin` scripts.
  onSuccess: async () => {
    const fs = await import("node:fs");
    fs.chmodSync("./dist/server.js", 0o755);
  },
});
