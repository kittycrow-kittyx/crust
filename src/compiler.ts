import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { Context, CompilerError, identifier } from "./context.js";
import { Emitter, isBuiltin } from "./emitter.js";
import { numericSource } from "./numbers.js";

export interface CompileRequest {
  readonly manifestPath: string;
  readonly outputDir: string;
}
export interface CompileResult {
  readonly files: number;
  readonly functions: number;
  readonly globals: number;
  readonly outputPath: string;
}
interface Manifest {
  readonly schema?: number;
  readonly target?: { compiler?: string; backend?: string; format?: string; freestanding?: boolean; intrinsicAbi?: number };
  readonly sourceFiles?: readonly string[];
}
const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true,
  noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
  types: [], skipLibCheck: true, noEmit: true
};

const handles = [
  "#[derive(Clone, Copy)] pub struct __bake_c_Buffer { pub handle: u64, pub byteLength: f64 }",
  "#[derive(Clone, Copy)] pub struct __bake_c_View { pub buffer: __bake_c_Buffer }",
  "#[derive(Clone, Copy)] pub struct __bake_c_ExternalMemory { pub buffer: __bake_c_Buffer }",
  ...["U8Array", "I32Array", "U64Array"].map(name =>
    "#[derive(Clone, Copy)] pub struct __bake_c_" + name + " { pub buffer: __bake_c_Buffer, pub length: f64 }")
].join("\n");

function sourceOrder(sources: readonly ts.SourceFile[], ctx: Context): ts.SourceFile[] {
  const files = new Map(sources.map(source => [path.resolve(source.fileName), source]));
  const visited = new Set<ts.SourceFile>();
  const result: ts.SourceFile[] = [];
  function visit(source: ts.SourceFile): void {
    if (visited.has(source)) return;
    visited.add(source);
    for (const stmt of source.statements) {
      if ((!ts.isImportDeclaration(stmt) && !ts.isExportDeclaration(stmt)) ||
          !stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      if (ts.isImportDeclaration(stmt) && stmt.importClause?.isTypeOnly || ts.isExportDeclaration(stmt) && stmt.isTypeOnly) continue;
      const resolved = ts.resolveModuleName(stmt.moduleSpecifier.text, source.fileName, options, ts.sys).resolvedModule;
      const dependency = resolved && files.get(path.resolve(resolved.resolvedFileName));
      if (!dependency) ctx.fail(stmt, "CU301", "external module");
      visit(dependency);
    }
    result.push(source);
  }
  for (const source of sources) visit(source);
  return result;
}

function publish(destination: string, outputs: ReadonlyMap<string, string>): void {
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.existsSync(destination) && !fs.existsSync(path.join(destination, "crust.manifest.json")))
    throw new Error("CU402: refusing to replace an unmanaged output directory");
  const stage = fs.mkdtempSync(path.join(parent, ".crust-stage-"));
  const backup = stage + "-previous";
  try {
    for (const [relative, content] of outputs) {
      const file = path.join(stage, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content.endsWith("\n") ? content : content + "\n");
    }
    if (fs.existsSync(destination)) fs.renameSync(destination, backup);
    try { fs.renameSync(stage, destination); }
    catch (error) {
      if (fs.existsSync(backup)) fs.renameSync(backup, destination);
      throw error;
    }
    fs.rmSync(backup, { recursive: true, force: true });
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

export function compile(request: CompileRequest): CompileResult {
  const manifestPath = path.resolve(request.manifestPath);
  const root = path.dirname(manifestPath);
  const destination = path.resolve(request.outputDir);
  if (destination === root || root.startsWith(destination + path.sep) || destination.startsWith(root + path.sep))
    throw new Error("CU401: output must be separate from Bake input");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
  if (manifest.schema !== 1 || manifest.target?.backend !== "rust" ||
      manifest.target.compiler !== "Crust" || manifest.target.format !== "lowered-typescript" ||
      manifest.target.freestanding !== true || manifest.target.intrinsicAbi !== 1)
    throw new Error("CU001: expected Bake Rust manifest schema 1 and intrinsic ABI 1");
  if (!Array.isArray(manifest.sourceFiles) || !manifest.sourceFiles.length)
    throw new Error("CU002: empty source manifest");
  const paths = manifest.sourceFiles.map(relative => {
    if (typeof relative !== "string" || path.isAbsolute(relative)) throw new Error("CU003: invalid source path");
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) || !file.endsWith(".ts") || !fs.existsSync(file) ||
        !fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep))
      throw new Error("CU003: invalid source path " + relative);
    return file;
  });
  if (new Set(paths).size !== paths.length) throw new Error("CU003: duplicate source path");
  const program = ts.createProgram(paths, options);
  const errors = ts.getPreEmitDiagnostics(program).filter(d => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    throw new Error("CU004: Bake output failed type checking\n" + ts.formatDiagnostics(errors, {
      getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => "\n"
    }));
  }
  const ctx = new Context(program, root);
  const emitter = new Emitter(ctx);
  const sources = paths.map(file => {
    const source = program.getSourceFile(file);
    if (!source || source.isDeclarationFile) throw new Error("CU005: missing implementation " + file);
    return source;
  });
  const names = sources.map(source => ctx.module(source));
  if (new Set(names).size !== names.length) throw new Error("CU006: colliding Rust module names");
  for (const source of sources) {
    for (const statement of source.statements) {
      if (ts.isInterfaceDeclaration(statement)) {
        ctx.register(statement.name, { name: ctx.recordName(statement), kind: "record", declaration: statement });
      } else if (ts.isFunctionDeclaration(statement) && statement.name) {
        const intrinsic = statement.name.text.startsWith("__bake_c_");
        if (intrinsic === Boolean(statement.body)) ctx.fail(statement, "CU302", "unexpected function body or ambient declaration");
        ctx.register(statement.name, { name: intrinsic ? statement.name.text : ctx.module(source) + "::" + identifier(statement.name.text),
          kind: intrinsic ? "intrinsic" : "function", declaration: statement });
      } else if (ts.isVariableStatement(statement)) {
        if (!(statement.declarationList.flags & ts.NodeFlags.Const)) ctx.fail(statement, "CU303", "mutable module global unsupported");
        for (const decl of statement.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || !decl.initializer) ctx.fail(decl, "CU304", "global requires a named initialiser");
          ctx.register(decl.name, { name: ctx.module(source) + "__" + identifier(decl.name.text), kind: "global", declaration: decl });
        }
      } else if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) || ts.isEmptyStatement(statement))) {
        ctx.fail(statement, "CU305", "unsupported module statement " + ts.SyntaxKind[statement.kind]);
      }
    }
  }
  const outputs = new Map<string, string>();
  const modules: string[] = [];
  const globalFields: string[] = [], globalDefaults: string[] = [], initialisers: string[] = [], platformMethods: string[] = [];
  let functions = 0;
  for (const entry of ctx.names.values()) {
    if (entry.kind !== "intrinsic" || isBuiltin(entry.name)) continue;
    const decl = entry.declaration;
    if (!ts.isFunctionDeclaration(decl)) ctx.fail(decl, "CU306", "invalid intrinsic declaration");
    const parameters = decl.parameters.map(param => {
      if (!ts.isIdentifier(param.name)) ctx.fail(param, "CU306", "invalid intrinsic parameter");
      const type = ctx.parameterType(param);
      return identifier(param.name.text) + ": " + (param.questionToken ? "Option<" + type + ">" : type);
    });
    platformMethods.push("    fn " + entry.name + "(&self" + (parameters.length ? ", " + parameters.join(", ") : "") + ") -> " + ctx.returnType(decl) + ";");
  }
  for (const source of sourceOrder(sources, ctx)) {
    const module = ctx.module(source);
    const relative = path.relative(root, source.fileName).replaceAll("\\", "/").replace(/\.ts$/, ".rs");
    const body = ["use crate::*;", ""];
    modules.push("#[path = " + JSON.stringify(relative) + "] pub mod " + module + ";");
    for (const statement of source.statements) {
      if (ts.isInterfaceDeclaration(statement) && !statement.name.text.startsWith("__bake_c_")) {
        const fields = statement.members.map(field => {
          if (!ts.isPropertySignature(field) || !ts.isIdentifier(field.name) || !field.type ||
              field.questionToken || !field.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ReadonlyKeyword))
            return ctx.fail(field, "CU307", "record must have readonly, statically typed fields");
          return "    pub " + identifier(field.name.text) + ": " + ctx.rustType(field.type, field) + ",";
        });
        body.push("#[derive(Clone, Copy)]", "pub struct " + identifier(statement.name.text) + " {", ...fields, "}", "");
      }
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          const entry = ctx.entry(decl.name)!;
          const type = ctx.rustType(decl.type, decl.name);
          globalFields.push("    pub(crate) " + entry.name + ": Option<" + type + ">,");
          globalDefaults.push("            " + entry.name + ": None,");
          initialisers.push("        ctx.globals." + entry.name + " = Some(" + emitter.expression(decl.initializer!, type) + ");");
        }
      }
      if (ts.isFunctionDeclaration(statement) && statement.body) {
        body.push(emitter.function(statement), "");
        functions++;
      }
    }
    outputs.set("src/" + relative, body.join("\n"));
  }
  // Initialisers use a shared context just like all generated functions.
  const initialisation = initialisers.map(line => line.replaceAll("(ctx,", "(&ctx,").replaceAll("(ctx)", "(&ctx)"));
  outputs.set("src/lib.rs", [
    "#![no_std]", "#![allow(non_snake_case, non_camel_case_types, unused_variables, unused_mut, unused_imports, unused_parens, unused_labels)]",
    "pub mod numbers;", "pub use numbers::Numeric;", handles, ...modules, "",
    "pub trait Platform {", ...platformMethods, "}", "",
    "pub struct Globals {", ...globalFields, "}", "",
    "pub struct Context<P: Platform> { pub platform: P, globals: Globals }",
    "impl<P: Platform> Context<P> {",
    "    pub fn new(platform: P) -> Self {",
    "        let mut ctx = Self { platform, globals: Globals {",
    ...globalDefaults, "        } };", ...initialisation, "        ctx", "    }", "}", ""
  ].join("\n"));
  outputs.set("src/numbers.rs", numericSource);
  outputs.set("Cargo.toml", '[package]\nname = "crust-kernel"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\npath = "src/lib.rs"\n');
  outputs.set("crust.manifest.json", JSON.stringify({
    schema: 1, format: "freestanding-rust", intrinsicAbi: 1,
    numericRepresentation: { number: "f64", bigint: "checked-i128" },
    modules: sources.map(source => ({ source: path.relative(root, source.fileName), rustModule: ctx.module(source) })),
    functions, globals: globalFields.length, platformIntrinsics: platformMethods.length
  }, null, 2));
  publish(destination, outputs);
  return { files: sources.length, functions, globals: globalFields.length, outputPath: destination };
}

export { CompilerError };
