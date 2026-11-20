// recorder.js — runs in a hidden window. Captures a whole display with getUserMedia,
// draws only the selected region onto a canvas and records that canvas with MediaRecorder.
// Encoded chunks are streamed to main, which appends them to a temp file.

const { ipcRenderer } = require('electron');

let recorder = null;
let stream = null;
let drawTimer = null;
let cancelled = false;
let sendChain = Promise.resolve(); // keeps chunks in order while their bytes are read

const MIME_CANDIDATES = [
  { mime: 'video/mp4;codecs=avc1,mp4a.40.2', ext: 'mp4', audio: true },
  { mime: 'video/mp4;codecs=avc1', ext: 'mp4', audio: false },
  { mime: 'video/webm;codecs=vp9,opus', ext: 'webm', audio: true },
  { mime: 'video/webm;codecs=vp9', ext: 'webm', audio: false },
  { mime: 'video/webm;codecs=vp8,opus', ext: 'webm', audio: true },
  { mime: 'video/webm', ext: 'webm', audio: false }
];

function pickFormat(withAudio) {
  return MIME_CANDIDATES.filter((c) => c.audio === withAudio).find((c) => MediaRecorder.isTypeSupported(c.mime)) || { mime: '', ext: 'webm' };
}

async function getDisplayStream({ sourceId, physW, physH, fps, audio }) {
  const video = {
    mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxWidth: physW, maxHeight: physH, maxFrameRate: fps }
  };
  if (audio) {
    try {
      // System audio (loopback) — supported on Windows.
      return await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } }, video });
    } catch (e) {
      ipcRenderer.send('rec-log', `Không thu được âm thanh hệ thống, quay không tiếng: ${e.message}`);
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: false, video });
}

const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

ipcRenderer.on('rec-init', async (_e, opts) => {
  try {
    const { crop, displayWidth, fps } = opts;
    stream = await getDisplayStream(opts);

    const video = document.getElementById('video');
    video.srcObject = stream;
    await video.play();
    if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));

    // Display DIPs -> captured video pixels
    const scale = video.videoWidth / displayWidth;
    const sx = Math.round(crop.x * scale), sy = Math.round(crop.y * scale);
    const sw = even(Math.min(Math.round(crop.w * scale), video.videoWidth - sx));
    const sh = even(Math.min(Math.round(crop.h * scale), video.videoHeight - sy));

    const canvas = document.getElementById('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d', { alpha: false });
    const draw = () => ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    draw();
    // A timer (not rAF) because this window is never shown; throttling is disabled for it.
    drawTimer = setInterval(draw, 1000 / fps);

    const out = canvas.captureStream(fps);
    const audioTracks = stream.getAudioTracks();
    audioTracks.forEach((t) => out.addTrack(t));

    const fmt = pickFormat(audioTracks.length > 0);
    const videoBitsPerSecond = Math.round(Math.min(40e6, Math.max(2.5e6, sw * sh * fps * 0.12)));
    recorder = new MediaRecorder(out, { mimeType: fmt.mime || undefined, videoBitsPerSecond, audioBitsPerSecond: 160000 });

    recorder.ondataavailable = (ev) => {
      if (cancelled || !ev.data || !ev.data.size) return;
      const blob = ev.data;
      sendChain = sendChain.then(async () => {
        if (!cancelled) ipcRenderer.send('rec-chunk', new Uint8Array(await blob.arrayBuffer()));
      });
    };
    recorder.onstop = () => {
      cleanup();
      // The final dataavailable fires before stop; wait until its bytes are sent.
      sendChain.then(() => ipcRenderer.send(cancelled ? 'rec-cancelled' : 'rec-finished'));
    };
    recorder.onerror = (ev) => {
      cleanup();
      ipcRenderer.send('rec-error', String(ev.error?.message || ev.error || 'MediaRecorder error'));
    };

    recorder.start(1000);
    ipcRenderer.send('rec-started', { ext: fmt.ext, width: sw, height: sh, audio: audioTracks.length > 0 });
  } catch (err) {
    cleanup();
    ipcRenderer.send('rec-error', err.message || String(err));
  }
});

ipcRenderer.on('rec-cmd', (_e, cmd) => {
  if (!recorder) return;
  if (cmd === 'pause' && recorder.state === 'recording') recorder.pause();
  else if (cmd === 'resume' && recorder.state === 'paused') recorder.resume();
  else if (cmd === 'stop' || cmd === 'cancel') {
    cancelled = cmd === 'cancel';
    if (recorder.state !== 'inactive') recorder.stop();
  }
});

function cleanup() {
  clearInterval(drawTimer);
  drawTimer = null;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}
