// Bundles the server (and @cold/core) into dist/index.js and copies migrations + the web build.
import { build } from "esbuild";
import { cpSync, existsSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/index.js",
  sourcemap: true,
  packages: "external",
  // @cold/core is a workspace TS package: bundle it instead of leaving it external.
  plugins: [
    {
      name: "bundle-core",
      setup(b) {
        b.onResolve({ filter: /^@cold\/core$/ }, () => ({ path: new URL("../../packages/core/src/index.ts", import.meta.url).pathname }));
      },
    },
  ],
});
cpSync("drizzle", "dist/drizzle", { recursive: true });
if (existsSync("../web/dist")) cpSync("../web/dist", "dist/public", { recursive: true });
console.log("server built → dist/");
