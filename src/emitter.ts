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
    if (expected === "Numeric") {
      if (actual === "f64") return "Numeric::Number(" + value + ")";
      if (actual === "i128") return "Numeric::BigInt(" + value + ")";
    }
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
    const args: string[] = [];
    for (let index = 0; index < decl.parameters.length; index++) {
      const parameter = decl.parameters[index]!;
      const argument = node.arguments[index];
      if (parameter.dotDotDotToken) return this.ctx.fail(parameter, "CU205", "rest parameter");
      const type = this.ctx.parameterType(parameter);
      if (argument) {
        const result = this.expression(argument, type);
        args.push(parameter.questionToken ? "Some(" + result + ")" : result);
      } else if (parameter.questionToken) args.push("None");
      else if (parameter.initializer) {
        // Only literal defaults are independent of the caller's evaluation context.
        const value = parameter.initializer;
        if (!(ts.isNumericLiteral(value) || ts.isBigIntLiteral(value) || ts.isStringLiteral(value) ||
          value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword))
          return this.ctx.fail(value, "CU206", "non-literal default argument");
        args.push(this.expression(value, type));
      } else return this.ctx.fail(node, "CU207", "missing argument");
    }
    if (node.arguments.length > decl.parameters.length) return this.ctx.fail(node, "CU207", "extra argument");
    if (entry.kind === "function") return "crate::" + entry.name + "(ctx" + (args.length ? ", " + args.join(", ") : "") + ")";
    const name = entry.name;
    if (builtin[name]) return "numbers::" + builtin[name] + "(" + args.join(", ") + ")";
    if (name === "__bake_c_f64_is_nan") return "(" + args[0] + ").is_nan()";
    if (name === "__bake_c_f64_is_integer") {
      const temp = this.ctx.temp();
      return "{ let " + temp + " = " + args[0] + "; " + temp + ".is_finite() && numbers::trunc(" + temp + ") == " + temp + " }";
    }
    if (name === "__bake_c_f32_round") return "((" + args[0] + ") as f32 as f64)";
    return "ctx.platform." + name + "(" + args.join(", ") + ")";
  }

  private local(node: ts.Expression): string {
    if (!ts.isIdentifier(node) || this.ctx.entry(node)) return this.ctx.fail(node, "CU208", "mutation requires a local binding");
    const symbol = this.ctx.symbol(node);
    if (!symbol?.declarations?.some(d => ts.isVariableDeclaration(d) || ts.isParameter(d)))
      return this.ctx.fail(node, "CU208", "unresolved local binding");
    return identifier(node.text);
  }

  private binary(node: ts.Node, op: string, left: string, right: string, a: string, b: string): string {
    const eq = op === "===" || op === "!==";
    if (a !== b) {
      if (eq && numeric.has(a) && numeric.has(b)) return "{ let _ = " + left + "; let _ = " + right + "; " + (op === "!==" ? "true" : "false") + " }";
      return this.ctx.fail(node, "CU209", "mixed operands " + a + " " + op + " " + b);
    }
    if (eq && (numeric.has(a) || a === "bool" || a === "&'static str"))
      return "(" + left + (op === "===" ? " == " : " != ") + right + ")";
    if (op === "==" || op === "!=") return this.ctx.fail(node, "CU210", "coercive equality unsupported");
    if (a === "f64") {
      const helper = numberOps[op];
      if (helper) return "numbers::" + helper + "(" + left + ", " + right + ")";
      if (["+", "-", "*", "/", "%", "<", ">", "<=", ">="].includes(op))
        return "(" + left + " " + op + " " + right + ")";
    }
    if (a === "i128") {
      const helper = bigintOps[op];
      if (helper) return "(" + left + ")." + helper + "(" + right + ").expect(\"BigInt arithmetic\")";
      if (op === "<<" || op === ">>") return "numbers::big_" + (op === "<<" ? "shl" : "shr") + "(" + left + ", " + right + ")";
      if (["&", "|", "^", "<", ">", "<=", ">="].includes(op)) return "(" + left + " " + op + " " + right + ")";
    }
    return this.ctx.fail(node, "CU211", "unsupported operator " + op + " for " + a);
  }

  expression(node: ts.Expression, expected?: string): string {
    const f = (value: ts.Expression, type?: string): string => this.expression(value, type);
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return "(" + f(node.expression, expected) + ")";
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node))
      return f(node.expression, expected ?? this.ctx.expressionType(node));
    if (ts.isObjectLiteralExpression(node)) {
      const type = expected ?? this.ctx.expressionType(node);
      if (!type.startsWith("crate::") && !type.startsWith("__bake_c_"))
        return this.ctx.fail(node, "CU212", "object literal requires a named record");
      const fields = node.properties.map(property => {
        if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name))
          return identifier(property.name.text) + ": " + f(property.initializer);
        if (ts.isShorthandPropertyAssignment(property)) {
          const symbol = this.ctx.checker.getShorthandAssignmentValueSymbol(property);
          const entry = symbol ? this.ctx.entries.get(symbol) : undefined;
          const value = entry?.kind === "global" ? "ctx.globals." + entry.name + ".expect(\"global initialisation\")" : identifier(property.name.text);
          return identifier(property.name.text) + ": " + value;
        }
        return this.ctx.fail(property, "CU213", "unsupported object field");
      });
      return type + " { " + fields.join(", ") + " }";
    }
    let actual = this.ctx.expressionType(node);
    let result: string;
    if (ts.isNumericLiteral(node)) {
      const value = Number(node.text.replaceAll("_", ""));
      if (!Number.isFinite(value)) return this.ctx.fail(node, "CU214", "non-finite literal");
      result = value.toString() + (/[.e]/i.test(value.toString()) ? "f64" : ".0f64");
    } else if (ts.isBigIntLiteral(node)) {
      const value = BigInt(node.text.slice(0, -1).replaceAll("_", ""));
      if (value > (1n << 127n) - 1n) return this.ctx.fail(node, "CU215", "BigInt literal exceeds i128");
      result = value.toString() + "i128";
    } else if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      result = node.kind === ts.SyntaxKind.TrueKeyword ? "true" : "false";
    } else if (ts.isStringLiteral(node)) {
      if (!/^[\x20-\x7e]*$/.test(node.text)) return this.ctx.fail(node, "CU216", "non-ASCII string literal");
      result = JSON.stringify(node.text);
    } else if (ts.isIdentifier(node)) {
      const entry = this.ctx.entry(node);
      if (entry?.kind === "global") result = "ctx.globals." + entry.name + ".expect(\"global initialisation\")";
      else if (!entry && this.ctx.symbol(node)?.declarations?.some(d => ts.isParameter(d) || ts.isVariableDeclaration(d) || ts.isBindingElement(d))) result = identifier(node.text);
      else return this.ctx.fail(node, "CU217", "unresolved value " + node.text);
    } else if (ts.isCallExpression(node)) {
      result = this.call(node);
    } else if (ts.isPropertyAccessExpression(node)) {
      result = "(" + f(node.expression) + ")." + identifier(node.name.text);
    } else if (ts.isConditionalExpression(node)) {
      const type = expected ?? actual;
      result = "(if " + this.condition(node.condition) + " { " + f(node.whenTrue, type) + " } else { " + f(node.whenFalse, type) + " })";
      actual = type;
    } else if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.getText();
      const a = this.ctx.expressionType(node.left), b = this.ctx.expressionType(node.right);
      if (op === "&&" || op === "||") {
        if (a === "bool" && b === "bool") result = "(" + f(node.left) + " " + op + " " + f(node.right) + ")";
        else return this.ctx.fail(node, "CU218", "logical operands must be boolean");
      } else if (op === ",") {
        result = "{ let _ = " + f(node.left) + "; " + f(node.right) + " }";
      } else if (op === "=" || ["+=","-=","*=","/=","%=","&=","|=","^=","<<=",">>=",">>>="].includes(op)) {
        const name = this.local(node.left);
        const value = op === "=" ? f(node.right, a) : this.binary(node, op.slice(0,-1), name, f(node.right), a, b);
        result = "{ " + name + " = " + value + "; " + name + " }";
      } else result = this.binary(node, op, f(node.left), f(node.right), a, b);
    } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      const op = ts.tokenToString(node.operator);
      const operand = node.operand;
      const type = this.ctx.expressionType(operand);
      if (op === "!" && ts.isPrefixUnaryExpression(node)) result = "(!" + this.condition(operand) + ")";
      else if (op === "~") result = type === "i128" ? "(!" + f(operand) + ")" : "numbers::not(" + f(operand) + ")";
      else if (op === "-") result = type === "i128" ? "(" + f(operand) + ").checked_neg().expect(\"BigInt negation\")" : "(-" + f(operand) + ")";
      else if (op === "+" && type === "f64") result = f(operand);
      else if (op === "++" || op === "--") {
        const name = this.local(operand);
        const old = this.ctx.temp();
        result = "{ let " + old + " = " + name + "; " + name + " = " +
          this.binary(node, op === "++" ? "+" : "-", old, type === "i128" ? "1i128" : "1.0f64", type, type) +
          "; " + (ts.isPostfixUnaryExpression(node) ? old : name) + " }";
      } else return this.ctx.fail(node, "CU219", "unsupported unary operator " + op);
    } else return this.ctx.fail(node, "CU220", "unsupported expression " + ts.SyntaxKind[node.kind]);
    return this.convert(node, actual, expected, result);
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

  statement(node: ts.Statement, returns: string): string {
    const s = (stmt: ts.Statement): string => this.statement(stmt, returns);
    if (ts.isBlock(node)) return "{\n" + node.statements.map(s).join("") + "}\n";
    if (ts.isVariableStatement(node)) return this.variables(node.declarationList);
    if (ts.isReturnStatement(node)) return node.expression ? "return " + this.expression(node.expression, returns) + ";\n" : "return;\n";
    if (ts.isIfStatement(node)) return "if " + this.condition(node.expression) + " {\n" + s(node.thenStatement) + "}\n" +
      (node.elseStatement ? "else {\n" + s(node.elseStatement) + "}\n" : "");
    if (ts.isWhileStatement(node)) {
      const label = "'" + this.ctx.temp();
      return label + ": while " + this.condition(node.expression) + " {\n" + this.loopBody(node.statement, returns, label, false) + "}\n";
    }
    if (ts.isForStatement(node) || ts.isDoStatement(node)) {
      const label = "'" + this.ctx.temp();
      const bodyLabel = label + "_body";
      let setup = "", condition = "", after = "";
      if (ts.isForStatement(node)) {
        if (node.initializer) setup = ts.isVariableDeclarationList(node.initializer) ? this.variables(node.initializer) : "let _ = " + this.expression(node.initializer) + ";\n";
        if (node.condition) condition = "if !(" + this.condition(node.condition) + ") { break " + label + "; }\n";
        if (node.incrementor) after = "let _ = " + this.expression(node.incrementor) + ";\n";
      } else after = "if !(" + this.condition(node.expression) + ") { break " + label + "; }\n";
      return "{\n" + setup + label + ": loop {\n" + condition + bodyLabel + ": {\n" +
        this.loopBody(node.statement, returns, label, true) + "}\n" + after + "}\n}\n";
    }
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      const loop = this.loops.at(-1);
      if (!loop || node.label) return this.ctx.fail(node, "CU222", "unresolved control-flow exit");
      if (ts.isBreakStatement(node)) return "break " + loop.label + ";\n";
      return loop.continueInside ? "break " + loop.label + "_body;\n" : "continue " + loop.label + ";\n";
    }
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
