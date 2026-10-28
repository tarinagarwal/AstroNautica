#!/usr/bin/env node
// Copies Noto Sans and Noto Sans Devanagari (SIL OFL 1.1, from the @expo-google-fonts npm packages) into the Android
// assets with the names React Native's font manager expects: <Family>.ttf, <Family>_bold.ttf, <Family>_italic.ttf.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, "../package.json"));
const out = resolve(here, "../android/app/src/main/assets/fonts");
mkdirSync(out, { recursive: true });

const pkg = (name) => dirname(require.resolve(`${name}/package.json`));
const sans = pkg("@expo-google-fonts/noto-sans");
const deva = pkg("@expo-google-fonts/noto-sans-devanagari");
const files = [
  [sans, "400Regular/NotoSans_400Regular.ttf", "NotoSans.ttf"],
  [sans, "700Bold/NotoSans_700Bold.ttf", "NotoSans_bold.ttf"],
  [sans, "400Regular_Italic/NotoSans_400Regular_Italic.ttf", "NotoSans_italic.ttf"],
  [sans, "700Bold_Italic/NotoSans_700Bold_Italic.ttf", "NotoSans_bold_italic.ttf"],
  [deva, "400Regular/NotoSansDevanagari_400Regular.ttf", "NotoSansDevanagari.ttf"],
  [deva, "700Bold/NotoSansDevanagari_700Bold.ttf", "NotoSansDevanagari_bold.ttf"],
];
for (const [base, from, to] of files) copyFileSync(resolve(base, from), resolve(out, to));
writeFileSync(resolve(out, "OFL.txt"), readFileSync(resolve(sans, "LICENSE_FONT")));
console.log(`copy-fonts: ${files.length} fonts -> android/app/src/main/assets/fonts`);
