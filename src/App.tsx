import { useCallback, useEffect, useRef, useState } from 'react';
import { readBarcodes } from 'zxing-wasm/reader';
import { Camera, Check, Copy, ExternalLink, ImagePlus, RefreshCw, ScanLine, ShieldCheck, Sparkles, Zap } from 'lucide-react';

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
    <header className="topbar"><a className="brand" href="#top"><span className="brand-mark"><ScanLine size={21}/></span><span>prism<span className="brand-light">scan</span></span><span className="beta">BETA</span></a><div className="top-note"><span className="live-dot"/> Runs locally in your browser</div></header>
    <section className="hero" id="top"><div className="eyebrow"><Sparkles size={14}/> SMART QR DECODING</div><h1>Not all QR codes<br/><span>are created equal.</span></h1><p className="subtitle">A fast, privacy-first scanner built to take a second look at stylized, low-contrast QR codes.</p><div className="hero-pills"><span><Zap size={14}/> Fast-first decoding</span><span><RefreshCw size={14}/> Adaptive recovery</span><span><ShieldCheck size={14}/> No image uploads</span></div></section>
    <section className="workspace">
      <div className="scanner-panel panel"><div className="panel-heading"><div><div className="section-kicker">SCANNER</div><h2>Scan a code</h2></div><span className={`status-chip ${result ? 'success' : ''}`}><span className="status-dot"/>{result ? 'Decoded' : status}</span></div>
        <div className={`camera-stage ${cameraOn ? 'camera-active' : ''}`}>
          <video ref={videoRef} className={cameraOn ? 'visible' : ''} playsInline muted aria-label="Live camera preview"/><canvas ref={canvasRef} className="processing-canvas"/>
          {!cameraOn && <div className="camera-placeholder"><div className="placeholder-icon"><Camera size={29}/></div><strong>Your scanner is ready</strong><span>Start your camera or upload a QR image to begin.</span></div>}
          {cameraOn && <div className="scan-overlay"><i className="corner tl"/><i className="corner tr"/><i className="corner bl"/><i className="corner br"/><span className="scan-line"/></div>}
          <div className="stage-label"><span className="live-dot"/>{cameraOn ? 'LIVE CAMERA' : 'AWAITING INPUT'}</div>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div className="scan-actions"><button className="button primary" onClick={cameraOn ? stopCamera : startCamera}>{cameraOn ? <><Camera size={17}/> Stop camera</> : <><Camera size={17}/> Start camera</>}</button><label className="button secondary upload-button"><ImagePlus size={17}/> Upload image<input type="file" accept="image/*" onChange={(event) => { void onUpload(event.target.files?.[0]); event.currentTarget.value = ''; }}/></label></div>
        <p className="permission-note"><ShieldCheck size={14}/> Camera frames are processed on-device and are not sent to a server.</p>
      </div>
      <aside className="right-column">
        <div className="result-panel panel"><div className="panel-heading"><div><div className="section-kicker">OUTPUT</div><h2>Scan result</h2></div><span className="result-icon"><Check size={17}/></span></div>
          {result ? <div className="result-content"><div className="decoded-badge"><Check size={13}/> QR CODE DECODED</div><div className="result-text">{result.text}</div><div className="result-meta"><span>{result.format}</span><span>{result.time.toFixed(0)} ms</span><span>{result.path}</span></div><div className="result-actions"><button className="button primary" onClick={() => void copyResult()}>{copied ? <Check size={16}/> : <Copy size={16}/>} {copied ? 'Copied' : 'Copy result'}</button>{isUrl(result.text) && <a className="button secondary" href={result.text} target="_blank" rel="noreferrer">Open link <ExternalLink size={15}/></a>}</div><button className="text-button" onClick={() => { setResult(null); setStatus('Ready to scan'); }}>Clear result</button></div> : <div className="empty-result"><div className="empty-glyph"><ScanLine size={25}/></div><strong>Nothing scanned yet</strong><span>Your decoded text or URL will appear here.</span></div>}
        </div>
        <div className="metrics-panel panel"><div className="section-kicker">SESSION METRICS</div><div className="metrics-grid"><div className="metric"><span>Successful scans</span><strong>{scans}</strong></div><div className="metric"><span>Recovered scans</span><strong>{recovered}</strong></div><div className="metric metric-wide"><span>Last decode time</span><strong>{lastLatency === null ? '—' : `${lastLatency.toFixed(0)} ms`}</strong><small>Measured in this browser session</small></div></div></div>
      </aside>
    </section>
    <section className="how-section"><div className="section-kicker">WHY PRISM SCAN</div><h2>Fast first. Smarter on retry.</h2><div className="feature-grid"><article className="feature-card"><span className="feature-icon violet"><Zap size={19}/></span><h3>Fast path first</h3><p>Try decoding the original frame before spending time on image transformations.</p></article><article className="feature-card"><span className="feature-icon blue"><Sparkles size={19}/></span><h3>Recovery on demand</h3><p>If the first attempt fails, try contrast normalization and Otsu thresholding.</p></article><article className="feature-card"><span className="feature-icon green"><ShieldCheck size={19}/></span><h3>Privacy by design</h3><p>Camera and uploaded images stay in your browser. No account or backend needed.</p></article></div></section>
    <footer><span>PRISM SCAN <span className="footer-muted">· College club prototype</span></span><span>Target: under 500 ms · Actual performance depends on device and QR design</span></footer>
  </main>;
}
