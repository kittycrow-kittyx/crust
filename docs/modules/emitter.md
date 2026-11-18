# emitter

`Emitter` translates typed TypeScript expressions, statements and function declarations into Rust source. It resolves calls through `Context`, preserves evaluation order and rejects unsupported operations. `isBuiltin` identifies Bake intrinsics implemented by the generated numeric runtime.
