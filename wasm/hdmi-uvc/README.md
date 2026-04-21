# hdmi-uvc WebAssembly hot kernels

Small AssemblyScript module that holds the per-frame hot loops used by
`src/lib/hdmi-uvc/` (CRC over the payload today; anchor detection and per-cell
classification will follow in later Phase 4 tasks).

## Toolchain

AssemblyScript (`assemblyscript` npm package) is installed as a dev
dependency of the root workspace. No system-level toolchain (emcc, clang,
wasm-ld) is required — `asc` runs entirely under Node.

Why AssemblyScript over Emscripten: the existing `libcimbar` WASM artifact
(`src/public/cimbar/`) is a vendored binary and its toolchain lives outside
this repo. For these in-tree kernels we want a build step that any contributor
can run with `pnpm install` and no additional setup. AS is a strict subset of
TypeScript that compiles to hand-sized WASM; it matches the scope of the
kernels (small arithmetic loops over pixel buffers) without dragging in an
allocator, `libc`, or a glue layer.

## Build

From the repo root:

```bash
pnpm build:wasm           # release build  → src/public/hdmi-uvc/hdmi_uvc.wasm
pnpm build:wasm:debug     # debug build    → src/public/hdmi-uvc/hdmi_uvc.debug.wasm
```

Both variants also emit a `.wat` (text) file alongside the binary so diffs are
readable in PRs. The release binary is checked in, the debug variant is
ignored via `.gitignore`.

The loader (`src/lib/hdmi-uvc/hdmi-uvc-wasm.js`) always fetches the release
binary at `/hdmi-uvc/hdmi_uvc.wasm` relative to the page.

## Runtime

The module uses AssemblyScript's `--runtime stub` so there is no GC and no
allocator. Memory layout is documented at the top of `src/index.ts`:

- `[0, 1024)` — CRC32 IEEE table, populated at first use.
- `[1024, ∞)` — scratch region. JS writes input buffers here and passes the
  offset + length to the exported kernels. JS grows memory via `growMemory`
  when the scratch region needs more room.

JS is responsible for never writing past the memory it has grown to. Kernels
trust the pointer/length they receive.

## Exports

| Name | Signature | Purpose |
|------|-----------|---------|
| `crc32` | `(ptr: u32, len: u32) -> u32` | IEEE-802.3 CRC32 over a byte range. Matches `src/lib/hdmi-uvc/crc32.js`. |
| `getScratchStart` | `() -> u32` | Offset of the scratch region in linear memory. |
| `getMemorySize` | `() -> i32` | Current number of 64 KiB pages in linear memory. |
| `growMemory` | `(pages: i32) -> i32` | Grow linear memory by `pages` 64 KiB pages. Returns the previous size or `-1` on failure. |
| `memory` | `WebAssembly.Memory` | Exported linear memory. JS reads/writes through a `Uint8Array` view. |

## Tests

`src/lib/hdmi-uvc/hdmi-uvc-wasm.js` exports `testWasmCrc32MatchesJs` which
loads the binary and asserts the exported `crc32` produces the same output as
the JS `crc32` for a set of fixed inputs plus a 4 KiB pseudo-random buffer.
Run it via the normal test harness: `pnpm dev` → `http://localhost:5173/?test`.
