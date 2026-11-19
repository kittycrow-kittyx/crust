# compiler

`compile` reads a Bake Rust manifest and publishes a generated crate. `CompileRequest` supplies the manifest and output directory; `CompileResult` records module, function and global counts and the output path. `CompilerError` reports unsupported source with a location. The compiler refuses to overwrite unrelated directories.
