import { useEffect, useRef, useState } from 'react';
import { sharpnessScore } from '../services/ocr.js';

// How many video frames to grab after "Capture" is pressed, and over how long.
// The sharpest one is used — this filters out the shake from tapping the
// button and momentary autofocus hunting, while still feeling instant.
const BURST_FRAMES = 6;
const BURST_MS = 450;
// Below this many pixels wide a video frame is too small for OCR; fall back
// to a full-resolution still photo.
const MIN_FRAME_WIDTH = 1280;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function nextFrame(video) {
  return new Promise((resolve) => {
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => resolve());
    else requestAnimationFrame(() => resolve());
  });
}

async function setFocus(track, mode) {
  const caps = track?.getCapabilities?.() || {};
  if (!caps.focusMode?.includes(mode)) return false;
  try {
    await track.applyConstraints({ advanced: [{ focusMode: mode }] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Live rear-camera preview with a capture button, plus "Add manual" to type
 * the order details without scanning (also the way out when the camera is
 * unavailable: http on a phone, permission denied, no camera).
 */
export default function CameraScanner({ onCapture, onManual }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const peakRef = useRef({ value: 0, at: 0 });
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sharp, setSharp] = useState(null); // null = unknown, true/false

  useEffect(() => {
    let cancelled = false;
    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Live camera needs HTTPS. Use "Add manual" instead.');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 3840 },
            height: { ideal: 2160 }
          },
          audio: false
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        await setFocus(stream.getVideoTracks()[0], 'continuous');
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setReady(true);
      } catch (e) {
        setError(`Camera unavailable (${e.name || e.message}). Use "Add manual" instead.`);
      }
    }
    start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Live blur indicator: compares current sharpness with the best seen in the
  // last few seconds (absolute values depend on the scene).
  useEffect(() => {
    if (!ready) return undefined;
    const id = setInterval(() => {
      const v = videoRef.current;
      if (!v?.videoWidth) return;
      const score = sharpnessScore(v, v.videoWidth, v.videoHeight);
      const now = Date.now();
      const peak = peakRef.current;
      if (score > peak.value || now - peak.at > 4000) peakRef.current = { value: score, at: now };
      setSharp(score >= Math.max(40, peakRef.current.value * 0.65));
    }, 300);
    return () => clearInterval(id);
  }, [ready]);

  async function stillPhoto(track) {
    if (!track || !('ImageCapture' in window)) return null;
    try {
      const blob = await new window.ImageCapture(track).takePhoto();
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  }

  async function capture() {
    const video = videoRef.current;
    const track = streamRef.current?.getVideoTracks?.()[0];
    setBusy(true);
    try {
      if (video.videoWidth < MIN_FRAME_WIDTH) {
        const photo = await stillPhoto(track);
        if (photo) return onCapture(photo);
      }
      // Burst: keep the sharpest full-resolution frame.
      const w = video.videoWidth;
      const h = video.videoHeight;
      let best = null;
      let bestScore = -1;
      const started = Date.now();
      for (let i = 0; i < BURST_FRAMES && Date.now() - started < BURST_MS; i++) {
        await nextFrame(video);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(video, 0, 0, w, h);
        const score = sharpnessScore(canvas, w, h);
        if (score > bestScore) {
          best = canvas;
          bestScore = score;
        }
        await wait(BURST_MS / BURST_FRAMES / 2);
      }
      onCapture(best.toDataURL('image/jpeg', 0.92));
    } finally {
      setBusy(false);
    }
  }

  // Tap the preview to refocus (phones that support single-shot focus).
  async function refocus() {
    const track = streamRef.current?.getVideoTracks?.()[0];
    if (await setFocus(track, 'single-shot')) {
      await wait(800);
      await setFocus(track, 'continuous');
    }
  }

  return (
    <div className="scanner">
      <div className="viewfinder" onClick={refocus}>
        <video ref={videoRef} playsInline muted />
        {ready && <div className={`frame-guide ${sharp === false ? 'blurry' : ''}`} />}
        {ready && sharp !== null && (
          <div className={`focus-badge ${sharp ? 'ok' : 'bad'}`}>
            {sharp ? 'Sharp' : 'Blurry — hold steady'}
          </div>
        )}
        {!ready && !error && <div className="overlay-msg">Starting camera…</div>}
        {error && <div className="overlay-msg">{error}</div>}
      </div>
      <p className="hint">
        Fit the top of the receipt inside the frame. Tap the preview to refocus.
      </p>
      <div className="actions">
        <button className="btn" onClick={onManual} disabled={busy}>
          Add manual
        </button>
        <button className="btn primary" onClick={capture} disabled={!ready || busy}>
          {busy ? 'Capturing…' : 'Capture'}
        </button>
      </div>
    </div>
  );
}
