import ts from "typescript";
import { Context, identifier, numeric } from "./context.js";

const numberOps: Readonly<Record<string, string>> = {
  "&": "and", "|": "or", "^": "xor", "<<": "shl", ">>": "shr", ">>>": "ushr"
};
const bigintOps: Readonly<Record<string, string>> = {
  "+": "checked_add", "-": "checked_sub", "*": "checked_mul",
  "/": "checked_div", "%": "checked_rem"
};
const builtin: Readonly<Record<string, string>> = {
  __bake_c_bigint: "bigint", __bake_c_number: "number",
  __bake_c_as_int_n: "as_int_n", __bake_c_as_uint_n: "as_uint_n",
  __bake_c_f64_trunc: "trunc", __bake_c_f64_floor: "floor",
  __bake_c_f64_ceil: "ceil", __bake_c_f64_min: "minimum",
  __bake_c_f64_max: "maximum", __bake_c_i32_mul: "imul"
};
export const isBuiltin = (name: string): boolean =>
  Object.hasOwn(builtin, name) || ["__bake_c_f64_is_nan", "__bake_c_f64_is_integer", "__bake_c_f32_round"].includes(name);

export class Emitter {
  private readonly loops: { label: string; continueInside: boolean }[] = [];
  constructor(readonly ctx: Context) {}

  convert(node: ts.Expression, actual: string, expected: string | undefined, value: string): string {
    if (!expected || actual === expected || actual === "!") return value;
    if (expected === "Numeric" && actual === "f64") return "Numeric::Number(" + value + ")";
    if (expected === "Numeric" && actual === "i128") return "Numeric::BigInt(" + value + ")";
    return this.ctx.fail(node, "CU201", "cannot convert " + actual + " to " + expected);
  }

  condition(node: ts.Expression): string {
    const kind = this.ctx.expressionType(node);
    const value = this.expression(node);
    if (kind === "bool") return value;
    if (kind === "f64") return "numbers::truth_number(" + value + ")";
    if (kind === "i128") return "numbers::truth_bigint(" + value + ")";
    if (kind === "&'static str") return "!(" + value + ").is_empty()";
    return this.ctx.fail(node, "CU202", "unsupported truth test " + kind);
  }

  private call(node: ts.CallExpression): string {
    if (!ts.isIdentifier(node.expression) || node.typeArguments?.length)
      return this.ctx.fail(node, "CU203", "call requires a statically resolved named function");
    const entry = this.ctx.entry(node.expression);
    if (!entry || (entry.kind !== "function" && entry.kind !== "intrinsic"))
      return this.ctx.fail(node, "CU204", "unresolved native function " + node.expression.text);
    const decl = entry.declaration;
    if (!ts.isFunctionDeclaration(decl)) return this.ctx.fail(node, "CU204", "invalid function declaration");
    const args = decl.parameters.map((parameter, index) => this.argument(node, parameter, node.arguments[index]));
    if (node.arguments.length > decl.parameters.length) return this.ctx.fail(node, "CU207", "extra argument");
    if (entry.kind === "function") return "crate::" + entry.name + "(ctx" + (args.length ? ", " + args.join(", ") : "") + ")";
    const name = entry.name;
    if (builtin[name]) return "numbers::" + builtin[name] + "(" + args.join(", ") + ")";
    if (name === "__bake_c_f64_is_nan") return "(" + args[0] + ").is_nan()";
    if (name === "__bake_c_f64_is_integer") {
      const temp = this.ctx.freshLocal();
      return "{ let " + temp + " = " + args[0] + "; " + temp + ".is_finite() && numbers::trunc(" + temp + ") == " + temp + " }";
    }
    if (name === "__bake_c_f32_round") return "((" + args[0] + ") as f32 as f64)";
    return "ctx.platform." + name + "(" + args.join(", ") + ")";
  }

  private argument(node: ts.CallExpression, parameter: ts.ParameterDeclaration, argument: ts.Expression | undefined): string {
    if (parameter.dotDotDotToken) return this.ctx.fail(parameter, "CU205", "rest parameter");
    const type = this.ctx.parameterType(parameter);
    if (argument) {
      const result = this.expression(argument, type);
      return parameter.questionToken ? "Some(" + result + ")" : result;
    }
    if (parameter.questionToken) return "None";
    const value = parameter.initializer;
    if (!value) return this.ctx.fail(node, "CU207", "missing argument");
    // Only literal defaults are independent of the caller's evaluation context.
    if (!(ts.isNumericLiteral(value) || ts.isBigIntLiteral(value) || ts.isStringLiteral(value) ||
      value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword))
      return this.ctx.fail(value, "CU206", "non-literal default argument");
    return this.expression(value, type);
  }

  private local(node: ts.Expression): string {
    if (!ts.isIdentifier(node) || this.ctx.entry(node)) return this.ctx.fail(node, "CU208", "mutation requires a local binding");
    const symbol = this.ctx.symbol(node);
    if (!symbol?.declarations?.some(d => ts.isVariableDeclaration(d) || ts.isParameter(d)))
      return this.ctx.fail(node, "CU208", "unresolved local binding");
    return identifier(node.text);
  }

  private mixedBinary(node: ts.Node, op: string, left: string, right: string, a: string, b: string): string {
    if (!numeric.has(a) || !numeric.has(b)) return this.ctx.fail(node, "CU209", "mixed operands " + a + " " + op + " " + b);
    if (op === "===" || op === "!==") return "{ let _ = " + left + "; let _ = " + right + "; " + (op === "!==" ? "true" : "false") + " }";
    const reverse: Readonly<Record<string, string>> = { "<": ">", ">": "<", "<=": ">=", ">=": "<=" };
    const relation = a === "f64" ? op : reverse[op];
    if (!relation || !["<", ">", "<=", ">="].includes(relation))
      return this.ctx.fail(node, "CU209", "mixed operands " + a + " " + op + " " + b);
    const method = relation === "<" ? "is_lt" : relation === ">" ? "is_gt" : relation === "<=" ? "is_le" : "is_ge";
    // Both operands retain their original evaluation order.
    const l = this.ctx.freshLocal(), r = this.ctx.freshLocal();
    return "{ let " + l + " = " + left + "; let " + r + " = " + right + "; numbers::compare_number_bigint(" +
      (a === "f64" ? l + ", " + r : r + ", " + l) + ").is_some_and(|order| order." + method + "()) }";
  }

  private binary(node: ts.Node, op: string, left: string, right: string, a: string, b: string): string {
    if (a !== b) return this.mixedBinary(node, op, left, right, a, b);
    const eq = op === "===" || op === "!==";
    if (eq && (numeric.has(a) || a === "bool" || a === "&'static str"))
      return "(" + left + (op === "===" ? " == " : " != ") + right + ")";
    if (op === "==" || op === "!=") return this.ctx.fail(node, "CU210", "coercive equality unsupported");
    const numberHelper = numberOps[op], bigintHelper = bigintOps[op];
    if (a === "f64" && numberHelper) return "numbers::" + numberHelper + "(" + left + ", " + right + ")";
    if (a === "f64" && ["+", "-", "*", "/", "%", "<", ">", "<=", ">="].includes(op)) return "(" + left + " " + op + " " + right + ")";
    if (a === "i128" && bigintHelper) return "(" + left + ")." + bigintHelper + "(" + right + ").expect(\"BigInt arithmetic\")";
    if (a === "i128" && (op === "<<" || op === ">>")) return "numbers::big_" + (op === "<<" ? "shl" : "shr") + "(" + left + ", " + right + ")";
    if (a === "i128" && ["&", "|", "^", "<", ">", "<=", ">="].includes(op)) return "(" + left + " " + op + " " + right + ")";
    return this.ctx.fail(node, "CU211", "unsupported operator " + op + " for " + a);
  }

  private field(property: ts.ObjectLiteralElementLike): string {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name))
      return identifier(property.name.text) + ": " + this.expression(property.initializer);
    if (!ts.isShorthandPropertyAssignment(property)) return this.ctx.fail(property, "CU213", "unsupported object field");
    const symbol = this.ctx.checker.getShorthandAssignmentValueSymbol(property);
    const entry = symbol ? this.ctx.entries.get(symbol) : undefined;
    const value = entry?.kind === "global" ? "ctx.globals." + entry.name + ".expect(\"global initialisation\")" : identifier(property.name.text);
    return identifier(property.name.text) + ": " + value;
  }

  private object(node: ts.ObjectLiteralExpression, expected?: string): string {
    const type = expected ?? this.ctx.expressionType(node);
    if (!type.startsWith("crate::") && !type.startsWith("__bake_c_"))
      return this.ctx.fail(node, "CU212", "object literal requires a named record");
    return type + " { " + node.properties.map(property => this.field(property)).join(", ") + " }";
  }

  private numberLiteral(node: ts.NumericLiteral): string {
    const value = Number(node.text.replaceAll("_", ""));
    if (!Number.isFinite(value)) return this.ctx.fail(node, "CU214", "non-finite literal");
    return value.toString() + (/[.e]/i.test(value.toString()) ? "f64" : ".0f64");
  }

  private bigintLiteral(node: ts.BigIntLiteral): string {
    const value = BigInt(node.text.slice(0, -1).replaceAll("_", ""));
    if (value > (1n << 127n) - 1n) return this.ctx.fail(node, "CU215", "BigInt literal exceeds i128");
    return value.toString() + "i128";
  }

  private valueName(node: ts.Identifier): string {
    const entry = this.ctx.entry(node);
    if (entry?.kind === "global") return "ctx.globals." + entry.name + ".expect(\"global initialisation\")";
    if (!entry && this.ctx.symbol(node)?.declarations?.some(d => ts.isParameter(d) || ts.isVariableDeclaration(d) || ts.isBindingElement(d))) return identifier(node.text);
    return this.ctx.fail(node, "CU217", "unresolved value " + node.text);
  }

  private binaryExpression(node: ts.BinaryExpression): string {
    const op = node.operatorToken.getText();
    const a = this.ctx.expressionType(node.left), b = this.ctx.expressionType(node.right);
    const logical = op === "&&" || op === "||";
    if (logical && (a !== "bool" || b !== "bool")) return this.ctx.fail(node, "CU218", "logical operands must be boolean");
    if (logical) return "(" + this.expression(node.left) + " " + op + " " + this.expression(node.right) + ")";
    if (op === ",") return "{ let _ = " + this.expression(node.left) + "; " + this.expression(node.right) + " }";
    if (op === "=" || ["+=","-=","*=","/=","%=","&=","|=","^=","<<=",">>=",">>>="].includes(op)) {
      const name = this.local(node.left);
      const value = op === "=" ? this.expression(node.right, a) : this.binary(node, op.slice(0,-1), name, this.expression(node.right), a, b);
      return "{ " + name + " = " + value + "; " + name + " }";
    }
    return this.binary(node, op, this.expression(node.left), this.expression(node.right), a, b);
  }

  private unary(node: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression): string {
    const op = ts.tokenToString(node.operator);
    const operand = node.operand;
    const type = this.ctx.expressionType(operand);
    if (op === "!" && ts.isPrefixUnaryExpression(node)) return "(!" + this.condition(operand) + ")";
    if (op === "~") return type === "i128" ? "(!" + this.expression(operand) + ")" : "numbers::not(" + this.expression(operand) + ")";
    if (op === "-") return type === "i128" ? "(" + this.expression(operand) + ").checked_neg().expect(\"BigInt negation\")" : "(-" + this.expression(operand) + ")";
    if (op === "+" && type === "f64") return this.expression(operand);
    if (op !== "++" && op !== "--") return this.ctx.fail(node, "CU219", "unsupported unary operator " + op);
    const name = this.local(operand);
    const old = this.ctx.freshLocal();
    return "{ let " + old + " = " + name + "; " + name + " = " +
      this.binary(node, op === "++" ? "+" : "-", old, type === "i128" ? "1i128" : "1.0f64", type, type) +
      "; " + (ts.isPostfixUnaryExpression(node) ? old : name) + " }";
  }

  private rawExpression(node: ts.Expression): string {
    if (ts.isNumericLiteral(node)) return this.numberLiteral(node);
    if (ts.isBigIntLiteral(node)) return this.bigintLiteral(node);
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return node.kind === ts.SyntaxKind.TrueKeyword ? "true" : "false";
    if (ts.isStringLiteral(node) && !/^[\x20-\x7e]*$/.test(node.text)) return this.ctx.fail(node, "CU216", "non-ASCII string literal");
    if (ts.isStringLiteral(node)) return JSON.stringify(node.text);
    if (ts.isIdentifier(node)) return this.valueName(node);
    if (ts.isCallExpression(node)) return this.call(node);
    if (ts.isPropertyAccessExpression(node)) return "(" + this.expression(node.expression) + ")." + identifier(node.name.text);
    if (ts.isBinaryExpression(node)) return this.binaryExpression(node);
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) return this.unary(node);
    return this.ctx.fail(node, "CU220", "unsupported expression " + ts.SyntaxKind[node.kind]);
  }

  expression(node: ts.Expression, expected?: string): string {
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return "(" + this.expression(node.expression, expected) + ")";
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node))
      return this.expression(node.expression, expected ?? this.ctx.expressionType(node));
    if (ts.isObjectLiteralExpression(node)) return this.object(node, expected);
    const actual = this.ctx.expressionType(node);
    if (ts.isConditionalExpression(node)) {
      const type = expected ?? actual;
      const result = "(if " + this.condition(node.condition) + " { " + this.expression(node.whenTrue, type) + " } else { " + this.expression(node.whenFalse, type) + " })";
      return this.convert(node, type, expected, result);
    }
    return this.convert(node, actual, expected, this.rawExpression(node));
  }

  private variables(list: ts.VariableDeclarationList): string {
    const mutable = !(list.flags & ts.NodeFlags.Const);
    return list.declarations.map(decl => {
      if (!ts.isIdentifier(decl.name) || (!decl.type && !decl.initializer))
        return this.ctx.fail(decl, "CU221", "local requires a named typed binding");
      const type = this.ctx.rustType(decl.type, decl.name);
      return "let " + (mutable ? "mut " : "") + identifier(decl.name.text) + ": " + type + (decl.initializer ? " = " + this.expression(decl.initializer, type) : "") + ";\n";
    }).join("");
  }

  private loopBody(node: ts.Statement, returns: string, label: string, continueInside: boolean): string {
    this.loops.push({label, continueInside});
    try { return this.statement(node, returns); } finally { this.loops.pop(); }
  }

  private countedLoop(node: ts.ForStatement | ts.DoStatement, returns: string): string {
    const label = "'" + this.ctx.freshLocal();
    const bodyLabel = label + "_body";
    const init = ts.isForStatement(node) ? node.initializer : undefined;
    const setup = init ? (ts.isVariableDeclarationList(init) ? this.variables(init) : "let _ = " + this.expression(init) + ";\n") : "";
    const condition = ts.isForStatement(node) && node.condition ? "if !(" + this.condition(node.condition) + ") { break " + label + "; }\n" : "";
    const after = ts.isForStatement(node) ? (node.incrementor ? "let _ = " + this.expression(node.incrementor) + ";\n" : "") : "if !(" + this.condition(node.expression) + ") { break " + label + "; }\n";
    return "{\n" + setup + label + ": loop {\n" + condition + bodyLabel + ": {\n" +
      this.loopBody(node.statement, returns, label, true) + "}\n" + after + "}\n}\n";
  }

  private loopExit(node: ts.BreakStatement | ts.ContinueStatement): string {
    const loop = this.loops.at(-1);
    if (!loop || node.label) return this.ctx.fail(node, "CU222", "unresolved control-flow exit");
    if (ts.isBreakStatement(node)) return "break " + loop.label + ";\n";
    return loop.continueInside ? "break " + loop.label + "_body;\n" : "continue " + loop.label + ";\n";
  }

  statement(node: ts.Statement, returns: string): string {
    // Loop labels preserve increment and condition evaluation on continue.
    const s = (stmt: ts.Statement): string => this.statement(stmt, returns);
    if (ts.isBlock(node)) return "{\n" + node.statements.map(s).join("") + "}\n";
    if (ts.isVariableStatement(node)) return this.variables(node.declarationList);
    if (ts.isReturnStatement(node)) return node.expression ? "return " + this.expression(node.expression, returns) + ";\n" : "return;\n";
    if (ts.isIfStatement(node)) return "if " + this.condition(node.expression) + " {\n" + s(node.thenStatement) + "}\n" +
      (node.elseStatement ? "else {\n" + s(node.elseStatement) + "}\n" : "");
    if (ts.isWhileStatement(node)) {
      const label = "'" + this.ctx.freshLocal();
      return label + ": while " + this.condition(node.expression) + " {\n" + this.loopBody(node.statement, returns, label, false) + "}\n";
    }
    if (ts.isForStatement(node) || ts.isDoStatement(node)) return this.countedLoop(node, returns);
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) return this.loopExit(node);
    if (ts.isExpressionStatement(node)) return "let _ = " + this.expression(node.expression) + ";\n";
    if (ts.isEmptyStatement(node)) return "";
    return this.ctx.fail(node, "CU223", "unsupported statement " + ts.SyntaxKind[node.kind]);
  }

  function(node: ts.FunctionDeclaration): string {
    if (!node.name || !node.body || node.typeParameters?.length) return this.ctx.fail(node, "CU224", "unsupported function");
    const parameters = node.parameters.map(p => {
      if (!ts.isIdentifier(p.name) || p.questionToken || p.dotDotDotToken) return this.ctx.fail(p, "CU225", "unsupported parameter");
      return "mut " + identifier(p.name.text) + ": " + this.ctx.parameterType(p);
    });
    const returns = this.ctx.returnType(node);
    return "pub fn " + identifier(node.name.text) + "<P: Platform>(ctx: &Context<P>" +
      (parameters.length ? ", " + parameters.join(", ") : "") + ") -> " + returns + " " +
      this.statement(node.body, returns);
  }
}
