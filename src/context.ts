import path from "node:path";
import ts from "typescript";

export class CompilerError extends Error {
  constructor(readonly code: string, readonly file: string, readonly line: number, message: string) {
    super(code + " " + file + ":" + line + ": " + message);
  }
}

export type Entry = {
  readonly kind: "record" | "function" | "global" | "intrinsic";
  readonly name: string;
  readonly declaration: ts.InterfaceDeclaration | ts.FunctionDeclaration | ts.VariableDeclaration;
};

export const numeric = new Set(["f64", "i128"]);
const reserved = new Set("as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await dyn abstract become box do final macro override priv typeof unsized virtual yield try gen".split(" "));

export function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || value === "_" || value.startsWith("__crust_")) {
    throw new Error("CU100: unsupported Rust identifier " + value);
  }
  return reserved.has(value) ? "ts_" + value : value;
}

const nativeRecords = new Set(["__bake_c_Buffer", "__bake_c_View", "__bake_c_ExternalMemory",
  "__bake_c_U8Array", "__bake_c_I32Array", "__bake_c_U64Array"]);

export class Context {
  readonly checker: ts.TypeChecker;
  readonly entries = new Map<ts.Symbol, Entry>();
  readonly names = new Map<string, Entry>();
  private serial = 0;

  constructor(readonly program: ts.Program, readonly root: string) {
    this.checker = program.getTypeChecker();
  }

  freshLocal(): string { return "__crust_v" + this.serial++; }

  fail(node: ts.Node, code: string, message: string): never {
    const source = node.getSourceFile();
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    throw new CompilerError(code, path.relative(this.root, source.fileName), line, message);
  }

  module(source: ts.SourceFile): string {
    const relative = path.relative(this.root, source.fileName).replaceAll("\\", "/").replace(/\.ts$/, "");
    const segments = relative.split("/");
    return "m_" + segments.map(segment => {
      if (!/^[A-Za-z0-9_-]+$/.test(segment)) this.fail(source, "CU101", "unsupported module path");
      return segment.replaceAll("-", "_");
    }).join("__");
  }

  symbol(node: ts.Node): ts.Symbol | null {
    const symbol = this.checker.getSymbolAtLocation(node) ?? null;
    return symbol && symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol ?? null;
  }

  register(node: ts.Identifier, entry: Entry): void {
    const symbol = this.symbol(node);
    if (!symbol) this.fail(node, "CU102", "unresolved declaration");
    const previous = this.names.get(entry.name) ?? null;
    if (previous && !entry.name.startsWith("__bake_c_")) this.fail(node, "CU103", "symbol collision: " + entry.name);
    if (previous && previous.kind !== entry.kind) this.fail(node, "CU103", "intrinsic collision");
    this.entries.set(symbol, previous ?? entry);
    if (!previous) this.names.set(entry.name, entry);
  }

  entry(node: ts.Node): Entry | null {
    const symbol = this.symbol(node);
    return symbol ? this.entries.get(symbol) ?? null : null;
  }

  recordName(node: ts.InterfaceDeclaration): string {
    const name = node.name.text;
    if (nativeRecords.has(name)) return name;
    return this.module(node.getSourceFile()) + "::" + identifier(name);
  }

  rustType(node: ts.TypeNode | null, origin: ts.Node): string {
    if (node && node.kind === ts.SyntaxKind.NeverKeyword) return "!";
    return this.typeOf(node ? this.checker.getTypeFromTypeNode(node) : this.checker.getTypeAtLocation(origin), origin);
  }

  private unionType(type: ts.UnionType, origin: ts.Node): string {
    const variants = [...new Set(type.types.map(item => this.typeOf(item, origin)))];
    const first = variants[0] ?? null;
    if (variants.length === 1 && first != null) return first;
    if (variants.length === 2 && variants.every(item => numeric.has(item))) return "Numeric";
    return this.fail(origin, "CU104", "unsupported union " + variants.join(" | "));
  }

  typeOf(type: ts.Type, origin: ts.Node): string {
    if (type.isUnion()) return this.unionType(type, origin);
    const flags = type.flags;
    if (flags & ts.TypeFlags.NumberLike) return "f64";
    if (flags & ts.TypeFlags.BigIntLike) return "i128";
    if (flags & ts.TypeFlags.BooleanLike) return "bool";
    if (flags & ts.TypeFlags.Never) return "!";
    if (flags & ts.TypeFlags.Void) return "()";
    if (flags & ts.TypeFlags.StringLike) return "&'static str";
    const symbol = type.getSymbol() ?? null;
    const entry = symbol ? this.entries.get(symbol) ?? null : null;
    if (entry && entry.kind === "record") return entry.name.startsWith("__bake_c_") ? entry.name : "crate::" + entry.name;
    this.fail(origin, "CU105", "unsupported type " + this.checker.typeToString(type));
  }

  expressionType(node: ts.Expression): string {
    return this.typeOf(this.checker.getTypeAtLocation(node), node);
  }

  returnType(node: ts.FunctionDeclaration): string {
    if (node.type ?? null) return this.rustType(node.type ?? null, node);
    const sig = this.checker.getSignatureFromDeclaration(node) ?? null;
    if (!sig) this.fail(node, "CU106", "missing function signature");
    return this.typeOf(sig.getReturnType(), node);
  }

  parameterType(node: ts.ParameterDeclaration): string {
    if (node.type ?? null) return this.rustType(node.type ?? null, node);
    return this.rustType(null, node.name);
  }
}
