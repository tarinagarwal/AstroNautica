// Two projects: framework-free logic in plain Node (real libsodium-wrappers, real crypto), and React Native UI
// components with the RN preset. pnpm keeps packages under node_modules/.pnpm, so ESM dependencies are transformed.
const esm = [
  "@azaadawaaz",
  "nostr-tools",
  "@noble",
  "@scure",
  "react-native",
  "@react-native",
  "react-native-.*",
  "blurhash",
  "markdown-it",
  "mdurl",
  "uc\\.micro",
  "linkify-it",
  "punycode\\.js",
  "entities",
  "fflate",
];
const transformIgnorePatterns = [`/node_modules/(?!(\\.pnpm/[^/]+/node_modules/)?(${esm.join("|")})/)`];

module.exports = {
  projects: [
    {
      displayName: "logic",
      testEnvironment: "node",
      testMatch: ["<rootDir>/src/**/__tests__/**/*.test.ts"],
      transform: { "^.+\\.[jt]sx?$": "babel-jest" },
      transformIgnorePatterns,
      setupFiles: ["<rootDir>/src/test/setup.ts"],
    },
    {
      displayName: "ui",
      preset: "@react-native/jest-preset",
      testMatch: ["<rootDir>/src/**/__tests__/**/*.test.tsx"],
      transformIgnorePatterns,
      setupFiles: ["<rootDir>/src/test/setupUi.ts"],
    },
  ],
};
