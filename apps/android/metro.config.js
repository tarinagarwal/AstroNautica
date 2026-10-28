/**
 * Metro for a pnpm monorepo: the app imports @azaadawaaz/* workspace packages (symlinks into ../../packages) and
 * pnpm's isolated node_modules (symlinks into ../../node_modules/.pnpm). `libsodium-wrappers` (WASM only; Hermes has
 * no WebAssembly) is replaced by a native adapter with the same API, so packages/core's staging code runs unchanged.
 */
const path = require("path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
const escape = (p) => p.replace(/[/\\]/g, "[/\\\\]").replace(/\./g, "\\.");

const config = {
  projectRoot,
  watchFolders: [workspaceRoot],
  resolver: {
    nodeModulesPaths: [path.resolve(projectRoot, "node_modules"), path.resolve(workspaceRoot, "node_modules")],
    unstable_enableSymlinks: true,
    unstable_enablePackageExports: true,
    disableHierarchicalLookup: false,
    blockList: [
      new RegExp(`^${escape(path.resolve(workspaceRoot, "apps/web"))}[/\\\\].*`),
      new RegExp(`^${escape(path.resolve(workspaceRoot, "services"))}[/\\\\].*`),
      new RegExp(`^${escape(path.resolve(workspaceRoot, "infra"))}[/\\\\].*`),
      new RegExp(`^${escape(path.resolve(workspaceRoot, "packages/contracts/lib"))}[/\\\\].*`),
      new RegExp(`^${escape(path.resolve(projectRoot, "android"))}[/\\\\].*`),
      new RegExp(`^${escape(path.resolve(projectRoot, "build"))}[/\\\\].*`),
    ],
    resolveRequest: (context, moduleName, platform) => {
      if (moduleName === "libsodium-wrappers") {
        return { type: "sourceFile", filePath: path.resolve(projectRoot, "src/crypto/sodiumNative.ts") };
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
