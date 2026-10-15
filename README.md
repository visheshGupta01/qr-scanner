# Prism Scan

A browser-based QR scanner prototype focused on fast decoding and recovery attempts for stylized QR codes.

## Features

- Live camera scanning and image upload
- ZXing WebAssembly decoding
- Canvas-based grayscale, contrast enhancement, and thresholding fallbacks
- Latency and recovery metrics
- React, TypeScript, and Vite

## Development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
npm run preview
```

Use HTTPS for camera access in deployed environments. The sub-500 ms objective is a target, not a guarantee; benchmark on your target devices and QR dataset.
