import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("emits a multi-module freestanding Rust crate", () => {
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
    assert.ok(lib.startsWith("#![no_std]\n#![forbid(unsafe_code)]\n"));
    assert.match(lib, /pub mod m_core__word;/);
    assert.match(lib, /pub mod m_native__kernel;/);
    assert.match(lib, /pub trait Platform/);
    const module = fs.readFileSync(path.join(p.outputDir, "src/native/kernel.rs"), "utf8");
    const word = fs.readFileSync(path.join(p.outputDir, "src/core/word.rs"), "utf8");
    assert.match(module, /pub fn step<P: Platform>/);
    assert.match(module, /pub fn signed<P: Platform>/);
    assert.match(module, /pub fn shift<P: Platform>/);
    assert.match(module, /m_core__word::word/);
    assert.match(word, /pub fn sx<P: Platform>/);
    assert.ok(fs.existsSync(path.join(p.outputDir, "Cargo.toml")));
    assert.ok(fs.existsSync(path.join(p.outputDir, "crust.manifest.json")));
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("rejects mutable globals and wrong target without publishing", () => {
  const p = fixture({ "input.ts": "export let global = 1;" });
  try {
    assert.throws(() => compile(p), /CU303/);
    assert.equal(fs.existsSync(p.outputDir), false);
    const manifest = decodeManifest(fs.readFileSync(p.manifestPath, "utf8"));
    const target = manifest.target ?? null;
    if (!isObject(target)) throw new Error("Missing manifest target");
    target.backend = "clang";
    fs.writeFileSync(p.manifestPath, JSON.stringify(manifest));
    assert.throws(() => compile(p), /CU001/);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("rejects unsupported syntax without replacing previous output", () => {
  const p = fixture({ "input.ts": "export function valid(a: number): number { return a + 1; }" });
  try {
    compile(p);
    const prior = fs.readFileSync(path.join(p.outputDir, "src/input.rs"), "utf8");
    const lib = fs.readFileSync(path.join(p.outputDir, "src/lib.rs"), "utf8");
    assert.doesNotMatch(lib, /globals: Globals/);
    fs.writeFileSync(path.join(path.dirname(p.manifestPath), "input.ts"),
      "export function invalid(): number { const items = [1, 2]; return items[0]!; }");
    assert.throws(() => compile(p), /CU105/);
    assert.equal(fs.readFileSync(path.join(p.outputDir, "src/input.rs"), "utf8"), prior);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
interface JsonObject { [key: string]: JsonValue; }
const decode: (text: string) => JsonValue = JSON.parse;
function isObject(value: JsonValue): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function decodeManifest(text: string): JsonObject {
  const value = decode(text);
  if (!isObject(value)) throw new Error("Invalid test manifest");
  return value;
}
