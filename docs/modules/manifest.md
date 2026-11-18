# Bake manifest reader

`readManifest(text)` parses JSON, checks the required target and intrinsic ABI, and returns a non-empty list of string source paths. Invalid JSON, incompatible targets and malformed source lists fail before TypeScript compilation. The compiler separately validates each path.
