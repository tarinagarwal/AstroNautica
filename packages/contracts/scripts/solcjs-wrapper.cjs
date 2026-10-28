#!/usr/bin/env node
const solc = require("solc");
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write(
    "solc, the solidity compiler commandline interface\nVersion: " +
      solc.version().replace("Emscripten.clang", "Linux.g++") +
      "\n",
  );
  process.exit(0);
}
if (!args.includes("--standard-json")) {
  process.stderr.write("only --standard-json supported\n");
  process.exit(1);
}
const bases = [];
for (let i = 0; i < args.length; i++) if (["--base-path", "--include-path"].includes(args[i])) bases.push(args[i + 1]);
bases.push(process.cwd());
const input = fs.readFileSync(0, "utf8");
const out = solc.compile(input, {
  import: (p) => {
    for (const b of bases) {
      const f = path.resolve(b, p);
      if (fs.existsSync(f)) return { contents: fs.readFileSync(f, "utf8") };
    }
    return { error: "File not found: " + p };
  },
});
process.stdout.write(out);
