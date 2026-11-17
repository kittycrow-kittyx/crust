import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { compile } from "../src/compiler.js";

function fixture(sources: Record<string, string>): { root: string; manifestPath: string; outputDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crust-"));
  const input = path.join(root, "input");
  fs.mkdirSync(input);
  for (const [name, source] of Object.entries(sources)) {
    const file = path.join(input, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  const manifestPath = path.join(input, "bake-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ schema: 1,
    target: { compiler: "Crust", backend: "rust", format: "lowered-typescript", intrinsicAbi: 1, freestanding: true },
    sourceFiles: Object.keys(sources)
  }));
  return { root, manifestPath, outputDir: path.join(root, "output") };
}

test("emits and executes a multi-module freestanding Rust crate", () => {
  const p = fixture({
    "core/word.ts": [
      "declare function __bake_c_bigint(value: number | bigint): bigint;",
      "declare function __bake_c_as_int_n(bits: number, value: bigint): bigint;",
      "export function word(value: number): bigint { return __bake_c_bigint(value); }",
      "export function sx(value: bigint): bigint { return __bake_c_as_int_n(64, value); }"
    ].join("\n"),
    "native/kernel.ts": [
      'import { word, sx } from "../core/word.js";',
      "export interface State { readonly pc: bigint; readonly hart: number; }",
      "const BASE: bigint = 0x1000n;",
      "export function initial(hart: number): State { return {pc: BASE, hart}; }",
      "export function step(state: State, delta: number): bigint {",
      "  let sum = 0;",
      "  for (let i = 0; i < delta; i += 1) { if (i === 2) continue; sum += i; }",
      "  return state.pc + word(sum);",
      "}",
      "export function signed(): bigint { return sx(0xffffffffffffffffn); }",
      "export function shift(): number { return (-1 >>> 0) & 255; }"
    ].join("\n")
  });
  try {
    const result = compile(p);
    assert.equal(result.files, 2);
    assert.equal(result.functions, 6);
    const lib = fs.readFileSync(path.join(p.outputDir, "src/lib.rs"), "utf8");
    assert.match(lib, /#!\[no_std\]/);
    const tests = path.join(p.outputDir, "tests");
    fs.mkdirSync(tests);
    fs.writeFileSync(path.join(tests, "smoke.rs"), [
      "use crust_kernel::{Context, Platform, m_native__kernel::*};",
      "struct Host; impl Platform for Host {}",
      "#[test] fn execution() {",
      "  let ctx = Context::new(Host);",
      "  assert_eq!(step(&ctx, initial(&ctx, 0.0), 6.0), 0x100d);",
      "  assert_eq!(signed(&ctx), -1);",
      "  assert_eq!(shift(&ctx), 255.0);",
      "}"
    ].join("\n"));
    const cargo = spawnSync("cargo", ["test", "--offline", "--manifest-path", path.join(p.outputDir, "Cargo.toml")], { encoding: "utf8" });
    assert.equal(cargo.status, 0, cargo.error?.message ?? cargo.stderr);
    fs.mkdirSync("build", { recursive: true });
    const published = path.resolve("build/fixture");
    fs.rmSync(published, { recursive: true, force: true });
    fs.cpSync(p.outputDir, published, { recursive: true, filter: source => path.basename(source) !== "target" });
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("rejects mutable globals and wrong target without publishing", () => {
  const p = fixture({ "input.ts": "export let global = 1;" });
  try {
    assert.throws(() => compile(p), /CU303/);
    assert.equal(fs.existsSync(p.outputDir), false);
    const manifest = JSON.parse(fs.readFileSync(p.manifestPath, "utf8"));
    manifest.target.backend = "clang";
    fs.writeFileSync(p.manifestPath, JSON.stringify(manifest));
    assert.throws(() => compile(p), /CU001/);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("rejects unsupported syntax without replacing previous output", () => {
  const p = fixture({ "input.ts": "export function valid(a: number): number { return a + 1; }" });
  try {
    compile(p);
    const prior = fs.readFileSync(path.join(p.outputDir, "src/input.rs"), "utf8");
    fs.writeFileSync(path.join(path.dirname(p.manifestPath), "input.ts"),
      "export function invalid(): number { const items = [1, 2]; return items[0]!; }");
    assert.throws(() => compile(p), /CU105/);
    assert.equal(fs.readFileSync(path.join(p.outputDir, "src/input.rs"), "utf8"), prior);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});
