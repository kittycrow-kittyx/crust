# Crust

Crust makes Rust Using Statically Typed TypeScript.

Crust translates Bake's `--target=rust` output into a freestanding Rust library.
Thistle remains the canonical kernel source.

## Build

```sh
npm install
npm run build
npm test
```

With sibling checkouts of Bake and Thistle:

```sh
node dist/src/thistle-project.js ../thistle
(cd ../bake && bun src/cli.ts --project ../thistle/tsconfig.crust.json --out-dir build/bake-rust --target=rust)
node dist/src/cli.js --manifest ../thistle/build/bake-rust/bake-manifest.json --out-dir build/rei
cargo check --manifest-path build/rei/Cargo.toml
```

## Contract

Crust consumes Bake manifest schema 1 and native intrinsic ABI 1. Generated
modules contain native Rust functions and use `#![no_std]` and
`#![forbid(unsafe_code)]`. The prohibition applies to the entire generated
crate and cannot be relaxed in a submodule. Any necessary unsafe platform
implementation must live outside that crate. No JavaScript runtime is linked. The generated crate exposes a platform trait for memory,
atomics, traps and other platform capabilities. A platform implementation and
boot integration are required to execute the kernel.

The initial numeric representation preserves TypeScript's IEEE-754 numbers
as `f64`. BigInts are bounded to checked `i128` operations, sufficient for
many RV64 operations but not arbitrary precision. Overflow traps rather than
silently wrapping. Explicit width conversions retain their source semantics.
This representation is provisional; it is not the final native kernel ABI.

The compiler supports statically resolved functions, scalar expressions,
immutable records, initialised module constants and structured loops.
Unsupported input fails with a source-located diagnostic. Module constants
are initialised once per generated context. Shared buffers remain platform
handles, not independently copied storage.

The linked fixture tests and canonical Thistle build in CI are distinct
milestones. Compilation alone does not establish semantic equivalence or
a bootable Rusty Rei.
