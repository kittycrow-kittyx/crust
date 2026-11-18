#!/usr/bin/env node
import { compile } from "./compiler.js";

const args = process.argv.slice(2);
function option(name: string): string | null {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1] ?? null;
  return args.find(arg => arg.startsWith(name + "="))?.slice(name.length + 1) ?? null;
}
const usage = "Usage: crust --manifest build/bake-rust/bake-manifest.json --out-dir build/rei-rust";
function main(): void {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage + "\n");
    return;
  }
  const manifestPath = option("--manifest");
  const outputDir = option("--out-dir");
  if (!manifestPath || !outputDir || manifestPath.startsWith("--") || outputDir.startsWith("--")) {
    process.stderr.write(usage + "\n");
    process.exitCode = 2;
    return;
  }
  try {
    const result = compile({ manifestPath, outputDir });
    process.stdout.write("Crust: emitted " + result.functions + " functions across " + result.files + " modules to " + result.outputPath + "\n");
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}
main();
