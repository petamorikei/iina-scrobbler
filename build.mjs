// Bundles the plugin into dist/ (one IIFE file per entry) for IINA's JavaScriptCore.
//
//   node build.mjs                          build (requires Last.fm credentials)
//   node build.mjs --allow-missing-secrets  build without credentials (auth will be disabled)
//   node build.mjs --watch                  rebuild on change
//
// Credentials come from the environment or from .env (git-ignored):
//   LASTFM_API_KEY, LASTFM_API_SECRET
import { existsSync } from "node:fs";
import process from "node:process";
import * as esbuild from "esbuild";

const args = new Set(process.argv.slice(2));
const watch = args.has("--watch");
const allowMissingSecrets = args.has("--allow-missing-secrets");

if (existsSync(".env")) process.loadEnvFile(".env");

const apiKey = process.env.LASTFM_API_KEY ?? "";
const apiSecret = process.env.LASTFM_API_SECRET ?? "";
if ((!apiKey || !apiSecret) && !allowMissingSecrets) {
  console.error(
    "LASTFM_API_KEY / LASTFM_API_SECRET are not set. Copy .env.example to .env and fill them in,\n" +
      "or pass --allow-missing-secrets to build without Last.fm credentials.",
  );
  process.exit(1);
}

/** @type {esbuild.BuildOptions} */
const options = {
  entryPoints: { main: "src/main/index.ts", global: "src/global/index.ts" },
  outdir: "dist",
  bundle: true,
  format: "iife",
  platform: "neutral",
  // JavaScriptCore on older macOS releases: lower ?. and ?? to be safe.
  target: "es2019",
  charset: "utf8",
  legalComments: "inline",
  logLevel: "info",
  define: {
    __LASTFM_API_KEY__: JSON.stringify(apiKey),
    __LASTFM_API_SECRET__: JSON.stringify(apiSecret),
  },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
