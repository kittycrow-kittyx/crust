# Crust

**CRUST**: Crust makes Rust Using Statically Typed TypeScript.

Crust translates TypeScript emitted by Bake's `rust` target into
freestanding Rust libraries.

## Transpiler validation

Bun is the required host runtime; no JavaScript build is needed.

```sh
bun install
bun run guards
bun run check
bun run test
```

## Transpile

Prepare the input using Bake's `--target=rust` option and pass the
generated manifest to Crust:

```sh
bun src/cli.ts --manifest /path/to/bake-output/bake-manifest.json --out-dir build/native
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

`src/thistle-project.ts` is an optional native-source preparation helper for
consumers. CI lowers and transpiles an independent arithmetic fixture and
checks the emitted crate without building native libraries or executables.

## Target contract

[`targets.json`](targets.json) declares the six architecture profiles that
Crust validates with `cargo check --lib`. The RV32 profile uses Rust's
supported bare-metal RV32IMAFC target; i686 needs nightly and `rust-src`
to check against a freestanding core library. Consumers may use the
`include` array as a build matrix. Platform compilation, linking and
execution belong to consumers.

## Licence

[MIT](LICENSE).

## Documentation

[Compiler module reference](docs/index.md). Run `bun run guards` to check source code, tests and documentation in strict mode.
