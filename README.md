# Qriosity

Air-gapped file transfer via QR codes. Transfer files between devices with zero network connectivity using fountain-coded QR streams.

## How It Works

1. **Sender** device encodes a file into a continuous stream of QR codes
2. **Receiver** device scans QR codes via camera and reconstructs the file
3. LT fountain codes provide redundancy - no acknowledgments needed, works even if some codes are missed

## Features

- **Air-gapped transfer** - No network, Bluetooth, or physical connection required
- **Fountain codes** - Rateless encoding means missed QR codes don't break the transfer
- **Single HTML file** - Download once, use offline forever
- **Hash verification** - SHA-256 ensures file integrity
- **Cross-device** - Works between any devices with a screen and camera
- **Mobile-optimized** - Auto-starts camera, simple toggle for front/back cameras
- **Drag & drop** - Drop files directly onto the sender screen

## Usage

### Quick Start

1. Open `dist/index.html` in a browser on both devices
2. On the sending device: Select "Send", drop or select a file
3. On the receiving device: Select "Receive", camera starts automatically
4. Wait for transfer to complete, file downloads automatically

### Sending

1. Click "Send"
2. Drag a file onto the drop zone or click to select (max 5MB)
3. Click "Start" to begin transmission
4. Adjust speed slider if needed (slower = more reliable)
5. QR codes cycle continuously - Pause/Resume or Stop as needed

### Receiving

1. Click "Receive" - camera starts automatically
2. Point at the QR code stream
3. Progress bar shows decoded blocks and transfer rate
4. File downloads automatically when complete
5. Click "Receive Another" for additional transfers

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

- **Encoding:** LT (Luby Transform) fountain codes
  - Systematic phase: symbols 1-K contain one source block each
  - Fountain phase: 15% degree-1, 85% degree-3 (XOR of 3 random blocks)
- **Block size:** 200 bytes (fixed)
- **QR payload:** ~216 bytes per code (16-byte header + 200-byte payload, Base64 encoded)
- **QR Error Correction:** Level M (15% recovery)
- **Protocol:** 16-byte binary header with session ID, block count, symbol ID, flags

## Limitations

- Max file size: 5MB
- Requires good lighting and steady camera positioning
- Browser must stay active during transfer (screen lock stops it)
- Transfer speed depends on camera quality, distance, and frame rate setting

## License

MIT
