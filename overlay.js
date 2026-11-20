// overlay.js — Lightshot-style region capture with annotation tools.
// All geometry is kept in CSS pixels (window coordinates). The screenshot
// itself may be larger (HiDPI); `scale` maps CSS pixels to image pixels.

const { ipcRenderer } = require('electron');

const COLORS = ['#ff0000', '#ff8800', '#ffdd00', '#33cc33', '#00bbff',
                '#2255ff', '#aa33ff', '#ff33aa', '#000000', '#ffffff'];
const HANDLE = 4;          // half size of resize handle squares
const MIN_SEL = 3;         // selections smaller than this are discarded

const img = new Image();
let canvas, ctx, dpr = 1, scale = 1;

// Selection: { x, y, w, h } or null
let sel = null;
// Interaction state
let mode = 'idle';         // idle | selecting | moving | resizing | drawing
let dragStart = null;      // { x, y }
let selAtDragStart = null;
let resizeEdge = null;     // e.g. 'nw', 'e'
// Annotation state
let tool = null;           // pen | line | arrow | rect | marker | text | null
let color = '#ff0000';
let lineWidth = 3;
let shapes = [];
let current = null;        // shape being drawn
let textEdit = null;       // { x, y } while the text box is open
let busy = false;          // an action has been sent to main

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- setup
window.addEventListener('DOMContentLoaded', () => {
  canvas = $('canvas');
  ctx = canvas.getContext('2d');
  buildPalette();
  bindToolbar();
  bindPointer();
  bindKeys();
  window.addEventListener('resize', resizeCanvas);
  window.focus();
});

// 'capture' = full Lightshot-style editor; 'ocr' = OCR & translate as soon as a region is picked;
// 'record' = pick/adjust a region, then start a screen recording of it
let overlayMode = 'capture';

ipcRenderer.on('set-image', (_e, dataUrl, mode) => {
  overlayMode = ['ocr', 'record'].includes(mode) ? mode : 'capture';
  document.body.classList.toggle('mode-record', overlayMode === 'record');
  img.onload = () => { resizeCanvas(); };
  img.src = dataUrl;
});

ipcRenderer.on('overlay-toast', (_e, msg) => toast(msg));

function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  scale = img.width ? img.width / window.innerWidth : dpr;
  render();
}

// ---------------------------------------------------------------- render
function render() {
  if (!ctx) return;
  const W = window.innerWidth, H = window.innerHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (img.complete && img.width) ctx.drawImage(img, 0, 0, W, H);

  // Dim everything outside the selection
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  if (!sel) {
    ctx.fillRect(0, 0, W, H);
  } else {
    const { x, y, w, h } = sel;
    ctx.fillRect(0, 0, W, y);
    ctx.fillRect(0, y + h, W, H - y - h);
    ctx.fillRect(0, y, x, h);
    ctx.fillRect(x + w, y, W - x - w, h);

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    for (const s of shapes) drawShape(ctx, s);
    if (current) drawShape(ctx, current);
    ctx.restore();

    drawFrame(sel);
  }
  updateChrome();
}

function drawFrame({ x, y, w, h }) {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#000';
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.setLineDash([]);
  for (const [hx, hy] of handlePoints(sel)) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(hx - HANDLE, hy - HANDLE, HANDLE * 2, HANDLE * 2);
    ctx.strokeStyle = '#000';
    ctx.strokeRect(hx - HANDLE + 0.5, hy - HANDLE + 0.5, HANDLE * 2 - 1, HANDLE * 2 - 1);
  }
  ctx.restore();
}

function handlePoints({ x, y, w, h }) {
  const cx = x + w / 2, cy = y + h / 2, r = x + w, b = y + h;
  return [[x, y, 'nw'], [cx, y, 'n'], [r, y, 'ne'], [r, cy, 'e'],
          [r, b, 'se'], [cx, b, 's'], [x, b, 'sw'], [x, cy, 'w']];
}

function drawShape(c, s) {
  c.save();
  c.strokeStyle = s.color;
  c.fillStyle = s.color;
  c.lineWidth = s.width;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  switch (s.type) {
    case 'pen':
    case 'marker': {
      if (s.type === 'marker') { c.globalAlpha = 0.4; c.lineCap = 'square'; }
      const p = s.points;
      c.beginPath();
      c.moveTo(p[0].x, p[0].y);
      if (p.length === 1) c.lineTo(p[0].x + 0.1, p[0].y);
      for (let i = 1; i < p.length; i++) c.lineTo(p[i].x, p[i].y);
      c.stroke();
      break;
    }
    case 'line':
      c.beginPath(); c.moveTo(s.x1, s.y1); c.lineTo(s.x2, s.y2); c.stroke();
      break;
    case 'arrow': {
      const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      const head = Math.min(len * 0.6, 10 + s.width * 3);
      c.beginPath(); c.moveTo(s.x1, s.y1);
      c.lineTo(s.x2 - Math.cos(ang) * head * 0.5, s.y2 - Math.sin(ang) * head * 0.5);
      c.stroke();
      c.beginPath();
      c.moveTo(s.x2, s.y2);
      c.lineTo(s.x2 - head * Math.cos(ang - Math.PI / 7), s.y2 - head * Math.sin(ang - Math.PI / 7));
      c.lineTo(s.x2 - head * Math.cos(ang + Math.PI / 7), s.y2 - head * Math.sin(ang + Math.PI / 7));
      c.closePath(); c.fill();
      break;
    }
    case 'rect':
      c.strokeRect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
      break;
    case 'text':
      c.font = `${s.size}px Arial, sans-serif`;
      c.textBaseline = 'top';
      s.text.split('\n').forEach((line, i) => c.fillText(line, s.x, s.y + i * s.size * 1.2));
      break;
  }
  c.restore();
}

// ---------------------------------------------------------------- chrome (toolbars, label)
function updateChrome() {
  const label = $('sizeLabel'), tv = $('toolsV'), th = $('toolsH');
  if (!sel) {
    label.style.display = tv.style.display = th.style.display = 'none';
    hidePalette();
    return;
  }
  const W = window.innerWidth, H = window.innerHeight;
  const { x, y, w, h } = sel;

  label.textContent = `${Math.round(w * scale)}x${Math.round(h * scale)}`;
  label.style.display = 'block';
  const lh = label.offsetHeight;
  const above = y - lh - 4 >= 0;
  label.style.left = `${above ? x : x + 4}px`;
  label.style.top = `${above ? y - lh - 4 : y + 4}px`;

  const showTools = mode !== 'selecting' && overlayMode !== 'ocr';
  tv.style.display = showTools && overlayMode !== 'record' ? 'flex' : 'none';
  th.style.display = showTools ? 'flex' : 'none';
  if (!showTools) return;

  // Vertical toolbar: right of selection, else left, else inside.
  const vw = tv.offsetWidth, vh = tv.offsetHeight, gap = 6;
  let vx = x + w + gap;
  if (vx + vw > W) vx = x - vw - gap >= 0 ? x - vw - gap : x + w - vw - gap;
  let vy = Math.min(Math.max(0, y + h - vh), H - vh);
  tv.style.left = `${vx}px`;
  tv.style.top = `${vy}px`;

  // Horizontal toolbar: below selection (right-aligned), else above, else inside.
  const hw = th.offsetWidth, hh = th.offsetHeight;
  let hx = Math.min(Math.max(0, x + w - hw), W - hw);
  let hy = y + h + gap;
  if (hy + hh > H) hy = y - hh - gap >= 0 ? y - hh - gap : y + h - hh - gap;
  th.style.left = `${hx}px`;
  th.style.top = `${hy}px`;
}

// ---------------------------------------------------------------- pointer
function bindPointer() {
  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('dblclick', () => { if (sel && !tool) overlayMode === 'record' ? startRecording() : doAction('copy'); });
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); cancel(); });
}

function hitHandle(px, py) {
  if (!sel) return null;
  for (const [hx, hy, edge] of handlePoints(sel)) {
    if (Math.abs(px - hx) <= HANDLE + 3 && Math.abs(py - hy) <= HANDLE + 3) return edge;
  }
  return null;
}

function inSel(px, py) {
  return sel && px >= sel.x && px <= sel.x + sel.w && py >= sel.y && py <= sel.y + sel.h;
}

function onDown(e) {
  if (e.button !== 0 || busy) return;
  hidePalette();
  if (textEdit) { commitText(); return; }
  const px = e.clientX, py = e.clientY;
  dragStart = { x: px, y: py };

  const edge = hitHandle(px, py);
  if (edge) {
    mode = 'resizing'; resizeEdge = edge; selAtDragStart = { ...sel };
    return;
  }
  if (inSel(px, py)) {
    if (tool === 'text') { openText(px, py); return; }
    if (tool) { startShape(px, py); return; }
    mode = 'moving'; selAtDragStart = { ...sel };
    return;
  }
  // Outside: start a brand-new selection (Lightshot behaviour), dropping annotations.
  mode = 'selecting';
  shapes = [];
  sel = { x: px, y: py, w: 0, h: 0 };
  render();
}

function onMove(e) {
  const px = clamp(e.clientX, 0, window.innerWidth), py = clamp(e.clientY, 0, window.innerHeight);
  if (mode === 'idle') { updateCursor(px, py); return; }

  if (mode === 'selecting') {
    sel = normRect(dragStart.x, dragStart.y, px, py);
  } else if (mode === 'moving') {
    const s = selAtDragStart;
    const nx = clamp(s.x + px - dragStart.x, 0, window.innerWidth - s.w);
    const ny = clamp(s.y + py - dragStart.y, 0, window.innerHeight - s.h);
    const dx = nx - sel.x, dy = ny - sel.y;
    sel = { ...s, x: nx, y: ny };
    // Annotations travel with the selection.
    shapes.forEach((sh) => offsetShape(sh, dx, dy));
  } else if (mode === 'resizing') {
    sel = resizeSel(selAtDragStart, resizeEdge, px - dragStart.x, py - dragStart.y);
  } else if (mode === 'drawing' && current) {
    extendShape(current, px, py, e.shiftKey);
  }
  render();
}

function onUp() {
  if (mode === 'selecting' && sel && (sel.w < MIN_SEL || sel.h < MIN_SEL)) sel = null;
  if (mode === 'selecting' && sel && overlayMode === 'ocr') {
    mode = 'idle';
    render();
    doAction('ocr');
    return;
  }
  if (mode === 'drawing' && current) {
    if (isMeaningful(current)) shapes.push(current);
    current = null;
  }
  mode = 'idle';
  render();
}

function updateCursor(px, py) {
  const edge = hitHandle(px, py);
  const cursors = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
                    n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
  if (edge) canvas.style.cursor = cursors[edge];
  else if (inSel(px, py)) canvas.style.cursor = tool === 'text' ? 'text' : tool ? 'crosshair' : 'move';
  else canvas.style.cursor = 'crosshair';
}

function resizeSel(s, edge, dx, dy) {
  let l = s.x, t = s.y, r = s.x + s.w, b = s.y + s.h;
  if (edge.includes('w')) l += dx;
  if (edge.includes('e')) r += dx;
  if (edge.includes('n')) t += dy;
  if (edge.includes('s')) b += dy;
  const W = window.innerWidth, H = window.innerHeight;
  const out = normRect(clamp(l, 0, W), clamp(t, 0, H), clamp(r, 0, W), clamp(b, 0, H));
  out.w = Math.max(out.w, 1); out.h = Math.max(out.h, 1);
  return out;
}

function normRect(x1, y1, x2, y2) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---------------------------------------------------------------- shapes
function startShape(px, py) {
  mode = 'drawing';
  if (tool === 'pen' || tool === 'marker') {
    current = { type: tool, color, width: tool === 'marker' ? lineWidth * 4 + 6 : lineWidth, points: [{ x: px, y: py }] };
  } else {
    current = { type: tool, color, width: lineWidth, x1: px, y1: py, x2: px, y2: py };
  }
  render();
}

function extendShape(s, px, py, shift) {
  if (s.points) { s.points.push({ x: px, y: py }); return; }
  if (shift && (s.type === 'line' || s.type === 'arrow')) {
    // Snap to 45° steps
    const ang = Math.round(Math.atan2(py - s.y1, px - s.x1) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(px - s.x1, py - s.y1);
    s.x2 = s.x1 + Math.cos(ang) * len; s.y2 = s.y1 + Math.sin(ang) * len;
  } else if (shift && s.type === 'rect') {
    const d = Math.max(Math.abs(px - s.x1), Math.abs(py - s.y1));
    s.x2 = s.x1 + Math.sign(px - s.x1) * d; s.y2 = s.y1 + Math.sign(py - s.y1) * d;
  } else {
    s.x2 = px; s.y2 = py;
  }
}

function isMeaningful(s) {
  if (s.points) return true;
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1) > 2;
}

function offsetShape(s, dx, dy) {
  if (s.points) s.points.forEach((p) => { p.x += dx; p.y += dy; });
  else if (s.type === 'text') { s.x += dx; s.y += dy; }
  else { s.x1 += dx; s.y1 += dy; s.x2 += dx; s.y2 += dy; }
}

// ---------------------------------------------------------------- text tool
function textSize() { return 12 + lineWidth * 3; }

function openText(px, py) {
  const ta = $('textInput');
  textEdit = { x: px, y: py };
  ta.value = '';
  ta.style.left = `${px}px`;
  ta.style.top = `${py}px`;
  ta.style.color = color;
  ta.style.fontSize = `${textSize()}px`;
  ta.style.width = '60px';
  ta.style.height = `${textSize() * 1.2 + 2}px`;
  ta.style.display = 'block';
  setTimeout(() => ta.focus(), 0);
}

function commitText() {
  const ta = $('textInput');
  if (!textEdit) return;
  const text = ta.value.replace(/\s+$/, '');
  if (text) shapes.push({ type: 'text', color, size: textSize(), x: textEdit.x + 1, y: textEdit.y + 1, text });
  textEdit = null;
  ta.style.display = 'none';
  ta.blur();
  render();
}

function autosizeText() {
  const ta = $('textInput');
  const lines = ta.value.split('\n');
  ctx.save();
  ctx.font = `${textSize()}px Arial, sans-serif`;
  const width = Math.max(60, ...lines.map((l) => ctx.measureText(l).width + 16));
  ctx.restore();
  ta.style.width = `${width}px`;
  ta.style.height = `${lines.length * textSize() * 1.2 + 2}px`;
}

// ---------------------------------------------------------------- toolbar
function bindToolbar() {
  document.querySelectorAll('[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => setTool(tool === btn.dataset.tool ? null : btn.dataset.tool));
  });
  $('btnColor').addEventListener('click', togglePalette);
  $('btnUndo').addEventListener('click', undo);
  $('btnOcr').addEventListener('click', () => doAction('ocr'));
  $('btnSearch').addEventListener('click', () => doAction('search'));
  $('btnPrint').addEventListener('click', () => doAction('print'));
  $('btnCopy').addEventListener('click', () => doAction('copy'));
  $('btnSave').addEventListener('click', () => doAction('save'));
  $('btnRecord').addEventListener('click', startRecording);
  $('btnClose').addEventListener('click', cancel);
  $('textInput').addEventListener('input', autosizeText);
  // Keep toolbar clicks from starting a new selection on the canvas below
  document.querySelectorAll('.toolbar, #palette').forEach((el) => el.addEventListener('mousedown', (e) => e.stopPropagation()));
  $('colorSwatch').style.background = color;
}

function setTool(t) {
  if (textEdit) commitText();
  tool = t;
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
}

function buildPalette() {
  const box = $('colors');
  COLORS.forEach((c) => {
    const d = document.createElement('div');
    d.className = 'c';
    d.style.background = c;
    d.dataset.color = c;
    d.addEventListener('click', () => {
      color = c;
      $('colorSwatch').style.background = c;
      box.querySelectorAll('.c').forEach((x) => x.classList.toggle('sel', x.dataset.color === c));
      if (textEdit) $('textInput').style.color = c;
    });
    if (c === color) d.classList.add('sel');
    box.appendChild(d);
  });
  const range = $('widthRange');
  range.value = lineWidth;
  $('widthVal').textContent = lineWidth;
  range.addEventListener('input', () => { lineWidth = +range.value; $('widthVal').textContent = lineWidth; });
}

function togglePalette() {
  const p = $('palette');
  if (p.style.display === 'block') return hidePalette();
  p.style.display = 'block';
  const b = $('btnColor').getBoundingClientRect();
  const pw = p.offsetWidth, ph = p.offsetHeight;
  let left = b.right + 6;
  if (left + pw > window.innerWidth) left = b.left - pw - 6;
  p.style.left = `${Math.max(0, left)}px`;
  p.style.top = `${clamp(b.top, 0, window.innerHeight - ph)}px`;
}
function hidePalette() { $('palette').style.display = 'none'; }

function undo() {
  if (textEdit) { textEdit = null; $('textInput').style.display = 'none'; return; }
  shapes.pop();
  render();
}

// ---------------------------------------------------------------- keyboard
function bindKeys() {
  window.addEventListener('keydown', (e) => {
    if (textEdit) {
      if (e.key === 'Escape' || (e.key === 'Enter' && e.ctrlKey)) { e.preventDefault(); commitText(); }
      return; // let the textarea handle everything else
    }
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') { e.preventDefault(); return cancel(); }
    if (!sel) return;
    if (e.ctrlKey && k === 'c') { e.preventDefault(); return doAction('copy'); }
    if (e.ctrlKey && k === 's') { e.preventDefault(); return doAction('save'); }
    if (e.ctrlKey && k === 'p') { e.preventDefault(); return doAction('print'); }
    if (e.ctrlKey && k === 'z') { e.preventDefault(); return undo(); }
    if (e.key === 'Enter') { e.preventDefault(); return overlayMode === 'record' ? startRecording() : doAction('ocr'); }
    if (e.ctrlKey || e.altKey) return;
    if (overlayMode === 'record') return;
    const map = { p: 'pen', l: 'line', a: 'arrow', r: 'rect', m: 'marker', t: 'text' };
    if (map[k]) setTool(tool === map[k] ? null : map[k]);
    // Arrow keys nudge the selection (Shift = resize)
    const step = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[k];
    if (step) {
      e.preventDefault();
      const [dx, dy] = step;
      if (e.shiftKey) sel = { ...sel, w: Math.max(1, sel.w + dx), h: Math.max(1, sel.h + dy) };
      else {
        const nx = clamp(sel.x + dx, 0, window.innerWidth - sel.w), ny = clamp(sel.y + dy, 0, window.innerHeight - sel.h);
        shapes.forEach((s) => offsetShape(s, nx - sel.x, ny - sel.y));
        sel = { ...sel, x: nx, y: ny };
      }
      render();
    }
  });
}

// ---------------------------------------------------------------- export & actions
function exportSelection() {
  const { x, y, w, h } = sel;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(w * scale));
  out.height = Math.max(1, Math.round(h * scale));
  const c = out.getContext('2d');
  c.drawImage(img, x * scale, y * scale, w * scale, h * scale, 0, 0, out.width, out.height);
  c.setTransform(scale, 0, 0, scale, -x * scale, -y * scale);
  for (const s of shapes) drawShape(c, s);
  return out.toDataURL('image/png');
}

async function doAction(action) {
  if (!sel || busy) return;
  if (textEdit) commitText();
  busy = true;
  const dataUrl = exportSelection();
  try {
    if (action === 'ocr') {
      await ipcRenderer.invoke('region-selected', dataUrl);
    } else {
      const res = await ipcRenderer.invoke('overlay-action', { action, dataUrl });
      if (res && res.keepOpen) { busy = false; if (res.message) toast(res.message); }
    }
  } catch (err) {
    busy = false;
    toast(`Lỗi: ${err.message || err}`);
  }
}

// Hand the region (CSS pixels of this window/display) to main, which starts the recorder.
async function startRecording() {
  if (!sel || busy) return;
  if (textEdit) commitText();
  busy = true;
  try {
    const res = await ipcRenderer.invoke('record-start', { x: sel.x, y: sel.y, w: sel.w, h: sel.h });
    if (res && res.keepOpen) { busy = false; if (res.message) toast(res.message); }
  } catch (err) {
    busy = false;
    toast(`Lỗi: ${err.message || err}`);
  }
}

function cancel() {
  if (textEdit) { textEdit = null; $('textInput').style.display = 'none'; return; }
  ipcRenderer.invoke('cancel-overlay');
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, 2500);
}
