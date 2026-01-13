# Beam Me Up

> *"Beam me up, Scotty!"*
>
> The iconic phrase from Star Trek that everyone knows - even though it was never actually said exactly that way in the original series. Captain Kirk would request transport back to the Enterprise, and Scotty would dematerialize him into a stream of light, sending his very atoms across the void of space.
>
> This app does something similar for your files. No network? No problem. Beam Me Up transforms your data into patterns of light (or sound) that travel through the air from one device to another. Like a transporter, but for files - and without the risk of having your atoms scrambled.

Air-gapped file transfer between devices with zero network connectivity. Uses multiple transfer modes including QR codes, CIMBAR (color-coded visual data), and more coming soon.

**Try it now:** [cyberian-hacksy.github.io/beammeup](https://cyberian-hacksy.github.io/beammeup/)

**100% Local & Private** - Nothing is uploaded to any server. All encoding, decoding, and file handling happens entirely in your browser. The app works offline after first load.

## How It Works

1. **Sender** device encodes a file into a continuous stream of visual (or audio) patterns
2. **Receiver** device captures the stream via camera (or microphone) and reconstructs the file
3. Fountain codes provide redundancy - no acknowledgments needed, works even if some frames are missed

## Transfer Modes

| Mode | Speed | Notes |
|------|-------|-------|
| **QR Transfer** | ~3-32 kbps | Standard QR format, lower data density |
| **CIMBAR Transfer** | ~850 kbps | High-density color-coded format |
| **Sound Transfer** | Coming soon | - |

All modes require this app on both sender and receiver devices.

## Features

- **Completely offline** - No server uploads, all processing happens locally in-browser
- **Air-gapped transfer** - No network, Bluetooth, or physical connection required
- **Multiple transfer modes** - Choose speed vs compatibility trade-off
- **Raptor-Lite coding** - Fountain codes with XOR parity pre-coding for efficient transfer
- **Single HTML file** - Download once, use offline forever
- **Hash verification** - SHA-256 ensures file integrity
- **Cross-device** - Works between any devices with a screen and camera
- **Mobile-optimized** - Auto-starts camera, simple toggle for front/back cameras
- **Drag & drop** - Drop files directly onto the sender screen
- **Large files** - Support for files up to 20MB

## Usage

### Quick Start

1. Open `dist/index.html` in a browser on both devices
2. On the sending device: Select a transfer mode and drop or select a file
3. On the receiving device: Select the matching receive mode, camera starts automatically
4. Wait for transfer to complete, file downloads automatically

### QR Transfer

Best for: Small files, compatibility with other apps

1. Click "SEND" under QR Transfer
2. Drag a file onto the drop zone or click to select (max 20MB)
3. Adjust presets as needed:
   - **Data** - Block size (Light 150B - Max 400B)
   - **Size** - QR display size (Small 240px - Large 400px)
   - **Speed** - Frame rate (Slow 200ms - Fast 50ms)
4. Click "Start" to begin transmission

### CIMBAR Transfer

Best for: Larger files, faster transfer when using this app on both ends

1. Click "SEND" under CIMBAR Transfer
2. Drop or select a file
3. Adjust size and speed presets
4. Click "Start" to begin high-speed transmission

## Development

```bash
# Install dependencies
pnpm install

# Development server
pnpm dev

# Build single-file output
pnpm build

# Run tests
# Visit http://localhost:5173/?test
```

## Technical Details

- **QR Encoding:** Raptor-Lite (LT fountain codes with XOR parity pre-coding)
  - Pre-coding: 3 layers of parity blocks (~3sqrt(K) blocks, 1-4% overhead)
  - Systematic phase: symbols 1-K' contain one intermediate block each
  - Fountain phase: 15% degree-1, 85% degree-3 (XOR of random blocks)
  - Two-phase decoder: belief propagation + parity recovery
- **CIMBAR:** Color-coded visual encoding using libcimbar
- **Block size:** Configurable 150-400 bytes for QR mode
- **Protocol:** 16-byte binary header with session ID, block count, symbol ID, block size, flags

## Limitations

- Max file size: 20MB
- Requires good lighting and steady camera positioning
- Browser must stay active during transfer (screen lock stops it)
- Transfer speed depends on camera quality, distance, and settings
- Large files (10MB+) may take significant time via QR mode

## Acknowledgments

CIMBAR transfer mode is powered by [libcimbar](https://github.com/sz3/libcimbar) by [sz3](https://github.com/sz3), an experimental high-density barcode format for air-gapped data transfer. The libcimbar WASM module is licensed under the [Mozilla Public License 2.0](https://www.mozilla.org/en-US/MPL/2.0/).

## License

MIT
