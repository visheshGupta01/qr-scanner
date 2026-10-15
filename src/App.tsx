import { useCallback, useEffect, useRef, useState } from 'react';
import { readBarcodes } from 'zxing-wasm/reader';

type ScanResult = { text: string; format: string; time: number; path: string };

async function decode(source: ImageData | HTMLCanvasElement) {
  // zxing-wasm accepts ImageData, not a canvas element; extract the pixels first.
  const imageData = source instanceof HTMLCanvasElement
    ? source.getContext('2d', { willReadFrequently: true })?.getImageData(0, 0, source.width, source.height)
    : source;
  if (!imageData) return [];
  return readBarcodes(imageData, { formats: ['QRCode'], tryHarder: true, tryRotate: true, tryInvert: true, maxNumberOfSymbols: 1 });
}

function makeRecoveryVariants(input: HTMLCanvasElement): HTMLCanvasElement[] {
  const variants: HTMLCanvasElement[] = [];
  const context = input.getContext('2d', { willReadFrequently: true });
  if (!context) return variants;
  const original = context.getImageData(0, 0, input.width, input.height);
  const width = input.width, height = input.height;
  const grayCanvas = document.createElement('canvas');
  grayCanvas.width = width; grayCanvas.height = height;
  const grayContext = grayCanvas.getContext('2d', { willReadFrequently: true });
  if (!grayContext) return variants;
  const gray = grayContext.createImageData(width, height);
  const luminance = new Uint8Array(width * height);
  let min = 255, max = 0;
  for (let i = 0, p = 0; i < original.data.length; i += 4, p++) {
    const value = Math.round(0.299 * original.data[i] + 0.587 * original.data[i + 1] + 0.114 * original.data[i + 2]);
    luminance[p] = value; min = Math.min(min, value); max = Math.max(max, value);
  }
  const range = Math.max(1, max - min);
  for (let i = 0, p = 0; i < gray.data.length; i += 4, p++) {
    const value = Math.max(0, Math.min(255, Math.round(((luminance[p] - min) / range) * 255)));
    gray.data[i] = value; gray.data[i + 1] = value; gray.data[i + 2] = value; gray.data[i + 3] = 255;
  }
  grayContext.putImageData(gray, 0, 0); variants.push(grayCanvas);

  // Otsu thresholding adds a binary variant for some low-contrast codes.
  const histogram = new Array<number>(256).fill(0);
  luminance.forEach((value) => histogram[value]++);
  const total = luminance.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];
  let sumBackground = 0, weightBackground = 0, bestVariance = -1, threshold = 127;
  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t];
    if (!weightBackground) continue;
    const weightForeground = total - weightBackground;
    if (!weightForeground) break;
    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (variance > bestVariance) { bestVariance = variance; threshold = t; }
  }
  const binaryCanvas = document.createElement('canvas');
  binaryCanvas.width = width; binaryCanvas.height = height;
  const binaryContext = binaryCanvas.getContext('2d');
  if (binaryContext) {
    const binary = binaryContext.createImageData(width, height);
    for (let i = 0, p = 0; i < binary.data.length; i += 4, p++) {
      const value = luminance[p] > threshold ? 255 : 0;
      binary.data[i] = value; binary.data[i + 1] = value; binary.data[i + 2] = value; binary.data[i + 3] = 255;
    }
    binaryContext.putImageData(binary, 0, 0); variants.push(binaryCanvas);
  }
  return variants;
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const busyRef = useRef(false);
  const lastScanRef = useRef(0);
  const [cameraOn, setCameraOn] = useState(false);
  const [status, setStatus] = useState('Ready to scan');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [scans, setScans] = useState(0);
  const [recovered, setRecovered] = useState(0);
  const [lastLatency, setLastLatency] = useState<number | null>(null);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
  }, []);

  const startCamera = useCallback(async () => {
    setError('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera access requires HTTPS or localhost in a supported browser.'); return;
    }
    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      setCameraOn(true); setStatus('Looking for a QR code…');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to start camera. Check browser permissions.');
    }
  }, [stopCamera]);

  const scanCanvas = useCallback(async (canvas: HTMLCanvasElement, label = 'Camera') => {
    if (busyRef.current) return;
    busyRef.current = true;
    const started = performance.now();
    try {
      const first = await decode(canvas);
      if (first[0]?.text) {
        const time = performance.now() - started;
        setResult({ text: first[0].text, format: first[0].format || 'QR Code', time, path: `${label} · direct` });
        setLastLatency(time); setScans((n) => n + 1); setStatus('QR code decoded'); lastScanRef.current = Date.now(); return;
      }
      setStatus('Trying image recovery…');
      const variants = makeRecoveryVariants(canvas);
      for (let i = 0; i < variants.length; i++) {
        const found = await decode(variants[i]);
        if (found[0]?.text) {
          const time = performance.now() - started;
          setResult({ text: found[0].text, format: found[0].format || 'QR Code', time, path: `${label} · recovery ${i + 1}` });
          setLastLatency(time); setScans((n) => n + 1); setRecovered((n) => n + 1); setStatus('Recovered successfully'); lastScanRef.current = Date.now(); return;
        }
      }
      setStatus('No QR found — adjust the frame or try another image');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Decode failed. Try a different image.');
      setStatus('Could not decode this frame');
    } finally { busyRef.current = false; }
  }, []);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const video = videoRef.current, canvas = canvasRef.current;
      if (cameraOn && video && canvas && video.readyState >= 2 && video.videoWidth > 0 && !busyRef.current && Date.now() - lastScanRef.current > 900) {
        const scale = Math.min(1, 960 / video.videoWidth);
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.getContext('2d', { willReadFrequently: true })?.drawImage(video, 0, 0, canvas.width, canvas.height);
        void scanCanvas(canvas);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [cameraOn, scanCanvas]);

  useEffect(() => () => streamRef.current?.getTracks().forEach((track) => track.stop()), []);

  const onUpload = async (file?: File) => {
    if (!file) return;
    setError(''); setResult(null); setStatus('Analyzing image…');
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = async () => {
      const canvas = canvasRef.current;
      if (!canvas) { URL.revokeObjectURL(url); return; }
      const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d', { willReadFrequently: true })?.drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url); await scanCanvas(canvas, 'Image');
    };
    image.onerror = () => { URL.revokeObjectURL(url); setError('Could not read that image file.'); };
    image.src = url;
  };

  const copyResult = async () => {
    if (!result) return;
    try { await navigator.clipboard.writeText(result.text); setCopied(true); window.setTimeout(() => setCopied(false), 1400); }
    catch { setError('Clipboard access was blocked by the browser.'); }
  };
  const isUrl = (text: string) => {
    try { const url = new URL(text); return url.protocol === 'http:' || url.protocol === 'https:'; }
    catch { return false; }
  };

  return <main className="app-shell">
    <header className="topbar"><a className="brand" href="#top">QR Scanner</a><span className="top-note">Runs in your browser</span></header>
    <section className="hero" id="top"><h1>Scan a code</h1><p className="subtitle">Start the camera or upload an image containing a QR code.</p></section>
    <section className="workspace">
      <div className="scanner-panel panel"><div className="panel-heading"><div><h2>Scanner</h2></div><span className={`status-chip ${result ? 'success' : ''}`}>{result ? 'Decoded' : status}</span></div>
        <div className={`camera-stage ${cameraOn ? 'camera-active' : ''}`}>
          <video ref={videoRef} className={cameraOn ? 'visible' : ''} playsInline muted aria-label="Live camera preview"/><canvas ref={canvasRef} className="processing-canvas"/>
          {!cameraOn && <div className="camera-placeholder"><strong>Your scanner is ready</strong><span>Start your camera or upload a QR image to begin.</span></div>}
          {cameraOn && <div className="scan-overlay"><i className="corner tl"/><i className="corner tr"/><i className="corner bl"/><i className="corner br"/></div>}
          <div className="stage-label">{cameraOn ? 'Camera on' : 'Waiting for input'}</div>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div className="scan-actions"><button className="button primary" onClick={cameraOn ? stopCamera : startCamera}>{cameraOn ? 'Stop camera' : 'Start camera'}</button><label className="button secondary upload-button">Choose image<input type="file" accept="image/*" onChange={(event) => { void onUpload(event.target.files?.[0]); event.currentTarget.value = ''; }}/></label></div>
        <p className="permission-note">Camera frames and uploaded images stay in this browser.</p>
      </div>
      <aside className="right-column">
        <div className="result-panel panel"><div className="panel-heading"><h2>Result</h2></div>
          {result ? <div className="result-content"><div className="decoded-badge">Decoded</div><div className="result-text">{result.text}</div><div className="result-meta"><span>{result.format}</span><span>{result.time.toFixed(0)} ms</span><span>{result.path}</span></div><div className="result-actions"><button className="button primary" onClick={() => void copyResult()}>{copied ? 'Copied' : 'Copy result'}</button>{isUrl(result.text) && <a className="button secondary" href={result.text} target="_blank" rel="noreferrer">Open link</a>}</div><button className="text-button" onClick={() => { setResult(null); setStatus('Ready to scan'); }}>Clear result</button></div> : <div className="empty-result"><strong>No result yet</strong><span>The decoded text or link will show here.</span></div>}
        </div>
        <div className="metrics-panel panel"><div className="metrics-title">Session stats</div><div className="metrics-grid"><div className="metric"><span>Successful scans</span><strong>{scans}</strong></div><div className="metric"><span>Recovered scans</span><strong>{recovered}</strong></div><div className="metric metric-wide"><span>Last decode time</span><strong>{lastLatency === null ? '—' : `${lastLatency.toFixed(0)} ms`}</strong><small>Time for the last successful decode</small></div></div></div>
      </aside>
    </section>
    <footer><span>QR Scanner</span><span>Decode time depends on the device and image quality.</span></footer>
  </main>;
}
