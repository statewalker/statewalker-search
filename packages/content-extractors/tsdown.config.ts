import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/extractors/index.ts", "src/index.ts", "src/types.ts"],
  unbundle: true,
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  // `.js` / `.d.ts` to match the `exports` of package.json.
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
