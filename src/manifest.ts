type JsonValue = null | boolean | number | string | JsonObject | JsonValue[];
interface JsonObject { [key: string]: JsonValue; }

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceList(value: JsonValue): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry: JsonValue) => typeof entry === "string");
}

// Without a reviver the standard parser returns only members of JsonValue.
const parseJson: (text: string) => JsonValue = JSON.parse;

export function readManifest(text: string): string[] {
  // JSON without a reviver can contain only JSON values. Check the manifest before accessing its fields.
  const value = parseJson(text);
  if (!isObject(value)) throw new Error("CU001: invalid Bake manifest");
  const target = value.target ?? null;
  if (!isObject(target) || (target.backend ?? null) !== "rust" || (target.freestanding ?? null) !== true || (value.schema ?? null) !== 1 || (target.compiler ?? null) !== "Crust" || (target.format ?? null) !== "lowered-typescript" || (target.intrinsicAbi ?? null) !== 1)
    throw new Error("CU001: expected Bake Rust manifest schema 1 and intrinsic ABI 1");
  const sources = value.sourceFiles ?? null;
  if (!sourceList(sources)) throw new Error("CU002: empty or invalid source manifest");
  return sources;
}
