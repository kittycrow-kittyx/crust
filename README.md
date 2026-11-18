# Crust

**CRUST**: Crust makes Rust Using Statically Typed TypeScript.

Crust translates TypeScript emitted by Bake's `rust` target into
freestanding Rust libraries.

## Build and test

```sh
npm install
npm run build
npm run check
npm test
```

## Compile

Prepare the input using Bake's `--target=rust` option and pass the
generated manifest to Crust:

```sh
node dist/src/cli.js --manifest /path/to/bake-output/bake-manifest.json --out-dir build/native
cargo check --manifest-path build/native/Cargo.toml
```

## Compiler contract

Crust consumes Bake manifest schema 1 and native intrinsic ABI 1.
Generated crates use `#![no_std]` and `#![forbid(unsafe_code)]`.

The generated platform trait defines memory, atomics, traps and other
platform operations. Its implementation belongs outside the generated
crate.

TypeScript numbers use `f64`. BigInt operations use bounded, checked
`i128` arithmetic rather than arbitrary precision. Explicit width
conversions preserve their source semantics.

Unsupported input produces a source-located diagnostic. Module
constants are initialised once per generated context. Shared buffers
retain their allocation identity through platform handles.

## Integration fixture

`src/thistle-project.ts` prepares Thistle source for compiler
integration tests. It is not required for other input projects.

## Licence

[MIT](LICENSE).

## Documentation

[Compiler module reference](docs/index.md). Run `npm run guards` to check source code, tests and documentation in strict mode.
