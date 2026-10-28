#!/usr/bin/env node
// Runs React Native codegen for the app's TurboModule specs (src/native/specs) the same way the Gradle plugin does,
// writing the schema and the generated Java spec classes to build/codegen. Used to check the specs without Gradle and
// to compile-check the Kotlin modules against the generated abstract classes.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const require = createRequire(resolve(root, "package.json"));
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const { name, jsSrcsDir, android } = pkg.codegenConfig;

const out = resolve(root, "build/codegen");
mkdirSync(out, { recursive: true });
const schema = resolve(out, "schema.json");
const combine = require.resolve("@react-native/codegen/lib/cli/combine/combine-js-to-schema-cli.js");
const generate = resolve(dirname(require.resolve("react-native/package.json")), "scripts/generate-specs-cli.js");

execFileSync(
  process.execPath,
  [combine, "--platform", "android", "--libraryName", name, schema, resolve(root, jsSrcsDir)],
  {
    stdio: "inherit",
  },
);
execFileSync(
  process.execPath,
  [
    generate,
    "--platform",
    "android",
    "--schemaPath",
    schema,
    "--outputDir",
    resolve(out, "android"),
    "--libraryName",
    name,
    "--javaPackageName",
    android.javaPackageName,
  ],
  { stdio: "inherit" },
);
console.log(`codegen: schema and Java specs written to ${out}`);
