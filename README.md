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

## Usage

### Quick Start

1. Open `dist/index.html` or https://cyberian-hacksy.github.io/qriosity/ in a browser on both devices
2. On the sending device: Select "Send", choose a file
3. On the receiving device: Select "Receive", point camera at QR codes
4. Wait for transfer to complete, file downloads automatically

### Sending

1. Click "Send File"
2. Select a file (max 5MB)
3. Adjust speed slider if needed (slower = more reliable)
4. QR codes will cycle continuously until receiver is done

### Receiving

1. Click "Receive File"
2. Select camera from dropdown
3. Point at the QR code stream
4. Progress bar shows decoded blocks
5. File downloads automatically when complete

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

- **Encoding:** LT (Luby Transform) fountain codes with fixed degree=3
- **Block size:** 200 bytes
- **QR payload:** ~900 bytes per code (error correction level M)
- **Protocol:** 16-byte binary header + payload, Base64 encoded

## Limitations

- Max file size: 5MB
- Requires good lighting and steady camera positioning
- Browser must stay active during transfer (screen lock stops it)
- Transfer speed depends on camera quality and distance

## License

MIT
