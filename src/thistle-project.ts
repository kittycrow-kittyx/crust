import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "../thistle");
const files = [
  "src/native/abi.ts", "src/native/kernel.ts", "src/native/memory.ts",
  "src/native/start.ts", "src/native/thx.ts", "src/native/types.ts",
  "src/native/vfs.ts", "src/native/word.ts"
];
for (const file of files) {
  if (!fs.existsSync(path.join(root, file))) throw new Error("Missing Thistle native file " + file);
}
const config = {
  compilerOptions: {
    target: "ES2022", module: "ESNext", moduleResolution: "Bundler",
    lib: ["ES2022", "DOM"], strict: true, skipLibCheck: true,
    noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
    types: [], noEmit: true
  },
  files
};
fs.writeFileSync(path.join(root, "tsconfig.crust.json"), JSON.stringify(config, null, 2) + "\n");
