# Prism Scan

A browser-based QR scanner prototype focused on fast decoding and recovery attempts for stylized QR codes.

## Features

- Live camera scanning with rear-camera preference
- QR image upload
- ZXing WebAssembly decode-first pipeline
- Recovery attempts using grayscale contrast normalization and Otsu thresholding
- Session metrics for successful scans, recovery count, and elapsed decode time
- Local browser processing; no backend required

## Stack

React, TypeScript, Vite, `zxing-wasm`, and Lucide icons.

## Run locally

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
npm run preview
```

Camera access requires HTTPS or localhost in supported browsers.

## Benchmarking

The 500 ms figure is a target, not a guarantee. The in-app timer reports decode-pipeline time for each successful attempt; it does not include camera startup or every aspect of camera-to-result latency. Test against a repeatable set of regular and stylized QR images, and report median and P95 latency plus the success rate.

The initial recovery implementation adds global contrast normalization and Otsu thresholding as fallback images. It does not guarantee decoding for QR codes whose data modules have been destroyed or obscured too severely.
