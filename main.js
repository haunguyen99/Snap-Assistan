// main.js — Snap Assistant (FINAL FIXED VERSION)
// ✅ Fixed typo (ipcMain not pcMain)
// ✅ Includes chat-ask handler, no syntax errors

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, Tray, Menu, clipboard, nativeImage, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const Tesseract = require('tesseract.js');
const StoreMod = require('electron-store');
const Store = StoreMod?.default || StoreMod;
const store = new Store();
const fetch = (...args) => import('node-fetch').then(({ default: _fetch }) => _fetch(...args));
const updater = require('./updater');

let mainWindow, resultWindow, overlayWindow, chatWindow, tray;
let tessServer = null;

// =============== Logger ===============
function log(...a) { console.log('[SnapAssistant]', ...a); }

// =============== IPC Handlers ===============
ipcMain.handle('get-api-key', () => store.get('geminiApiKey') || '');
ipcMain.handle('save-api-key', (_e, key) => {
  const trimmed = String(key || '').trim();
  if (trimmed) { store.set('geminiApiKey', trimmed); return true; }
  store.delete('geminiApiKey'); return false;
});





ipcMain.handle('chat-get-history', async () => store.get('chatHistory', []));
ipcMain.handle('chat-clear', async () => { store.delete('chatHistory'); return { ok: true }; });
ipcMain.handle('chat-export', async () => {
  const history = store.get('chatHistory', []);
  if (history.length === 0) return { ok: false, error: 'Không có dữ liệu để xuất' };
  const filename = `chat-history-${Date.now()}.txt`;
  const filepath = path.join(app.getPath('downloads'), filename);
  let content = history.map(h => `${h.role}: ${h.text}`).join('\n\n');
  await fsp.writeFile(filepath, content, 'utf8');
  return { ok: true, filename, filepath };
});

// ===== Auto Launch =====
ipcMain.handle('get-auto-launch', async () => {
  try {
    // Giả lập trạng thái auto-launch (vì module auto-launch có thể chưa cài)
    const enabled = store.get('autoLaunch') || false;
    return { enabled };
  } catch (e) {
    console.error('get-auto-launch error:', e);
    return { enabled: false, error: e.message };
  }
});

ipcMain.handle('set-auto-launch', async (_e, enabled) => {
  try {
    store.set('autoLaunch', !!enabled);
    return { ok: true, enabled };
  } catch (e) {
    console.error('set-auto-launch error:', e);
    return { ok: false, error: e.message };
  }
});


// ✅ Fixed: correct ipcMain usage
ipcMain.handle('chat-ask', async (_event, message) => {
  const apiKey = store.get('geminiApiKey');
  if (!apiKey) {
    return { ok: false, text: '❌ Chưa có API key. Vào Settings để nhập.' };
  }

  // Đảm bảo message là chuỗi (nếu renderer gửi object)
  const text = typeof message === 'string'
    ? message
    : (message?.text || JSON.stringify(message, null, 2));

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const body = {
      contents: [{ role: 'user', parts: [{ text }] }]
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await res.json();
    if (data?.error) {
      if (data.error.code === 429)
        return { ok: false, text: '⚠️ Gemini báo hết quota hoặc giới hạn. Thử lại sau 1 phút hoặc dùng API key khác.' };
      return { ok: false, text: `❌ Lỗi API: ${data.error.message}` };
    }

    // Lấy phản hồi từ Gemini
    let replyRaw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '❌ Không có phản hồi';

    // Làm sạch nếu Gemini trả về JSON hoặc code block
    let reply = replyRaw
      .replace(/^```[a-zA-Z]*\\n?/, '')
      .replace(/```$/, '')
      .replace(/^json\\s*/i, '')
      .trim();

    // Nếu vẫn còn là JSON hợp lệ, parse rồi lấy message
    try {
      const parsed = JSON.parse(reply);
      if (parsed?.message) reply = parsed.message;
    } catch (_) {}

    // Lưu lịch sử
    const hist = store.get('chatHistory', []);
    hist.push({ role: 'user', text });
    hist.push({ role: 'assistant', text: reply });
    store.set('chatHistory', hist);

    return { ok: true, text: reply };
  } catch (err) {
    console.error('chat-ask error', err);
    return { ok: false, text: '❌ Lỗi khi gọi tới Gemini (kiểm tra mạng hoặc API key).' };
  }
});





ipcMain.handle('get-single-capture', () => !!store.get('singleCapture', true));
ipcMain.handle('set-single-capture', (_e, on) => { store.set('singleCapture', !!on); return !!on; });

// =============== Global hotkeys (3 main features) ===============
// An empty accelerator means the feature has no hotkey.
const HOTKEYS = {
  capture: { storeKey: 'captureHotkey', def: 'CommandOrControl+Shift+X', label: 'Chụp màn hình', run: () => openOverlay('capture') },
  ocr:     { storeKey: 'hotkey',        def: 'CommandOrControl+Shift+S', label: 'OCR & Dịch',     run: () => openOverlay('ocr') },
  // Same key opens the region picker and, while recording, stops and saves.
  record:  { storeKey: 'recordHotkey',  def: 'CommandOrControl+Alt+R',   label: 'Quay video',     run: () => toggleRecording() },
  chat:    { storeKey: 'chatHotkey',    def: 'CommandOrControl+Shift+C', label: 'Chat AI',        run: () => { if (!chatWindow) createChatWindow(); openOrFocus(chatWindow); } }
};
const activeHotkeys = {}; // id -> accelerator currently registered

function getHotkey(id) { return String(store.get(HOTKEYS[id].storeKey, HOTKEYS[id].def) ?? ''); }

function registerHotkey(id, accel) {
  if (!accel) return true;
  try {
    const ok = globalShortcut.register(accel, () => Promise.resolve(HOTKEYS[id].run()).catch(console.error));
    if (ok) activeHotkeys[id] = accel;
    return ok;
  } catch (e) {
    log(`Phím tắt không hợp lệ (${id}): ${accel}`, e.message);
    return false;
  }
}

function unregisterHotkeys() {
  for (const accel of Object.values(activeHotkeys)) globalShortcut.unregister(accel);
  for (const id of Object.keys(activeHotkeys)) delete activeHotkeys[id];
}

// Registers the saved hotkeys; returns { id: true|false } (false = taken by another app or invalid).
function registerAllHotkeys() {
  unregisterHotkeys();
  const result = {};
  for (const id of Object.keys(HOTKEYS)) {
    const accel = getHotkey(id);
    result[id] = registerHotkey(id, accel);
    if (accel) log(`Phím tắt ${HOTKEYS[id].label}: ${accel} ${result[id] ? '✓' : '✗ (đã bị chiếm hoặc không hợp lệ)'}`);
  }
  return result;
}

ipcMain.handle('get-hotkeys', () => {
  const out = {};
  for (const id of Object.keys(HOTKEYS)) {
    out[id] = { accel: getHotkey(id), def: HOTKEYS[id].def, label: HOTKEYS[id].label, active: activeHotkeys[id] === getHotkey(id) && !!activeHotkeys[id] };
  }
  return out;
});

ipcMain.handle('save-hotkeys', (_e, map = {}) => {
  const next = {};
  for (const id of Object.keys(HOTKEYS)) next[id] = String(map[id] ?? getHotkey(id)).trim();

  const seen = {};
  for (const [id, accel] of Object.entries(next)) {
    if (!accel) continue;
    if (seen[accel]) return { ok: false, error: `${HOTKEYS[id].label} trùng phím với ${HOTKEYS[seen[accel]].label}` };
    seen[accel] = id;
  }

  const previous = {};
  for (const id of Object.keys(HOTKEYS)) previous[id] = getHotkey(id);
  for (const [id, accel] of Object.entries(next)) store.set(HOTKEYS[id].storeKey, accel);
  const result = registerAllHotkeys();

  const failed = Object.keys(result).filter(id => !result[id]);
  if (failed.length) {
    // Keep working hotkeys; restore the old value for the ones that failed.
    for (const id of failed) store.set(HOTKEYS[id].storeKey, previous[id]);
    registerAllHotkeys();
    return { ok: false, failed, error: `Không đăng ký được: ${failed.map(id => `${HOTKEYS[id].label} (${next[id]})`).join(', ')} — phím có thể đã bị app khác dùng` };
  }
  return { ok: true };
});

// While the settings window records a new combo, stop global hotkeys from firing.
ipcMain.on('hotkeys-suspend', () => unregisterHotkeys());
ipcMain.on('hotkeys-resume', () => registerAllHotkeys());

ipcMain.on('close-main', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide(); });

log('✅ IPC handlers registered');

// =============== Window Helpers ===============
function installMinimizeToTray(win) {
  win.on('close', (e) => { if (!app.isQuiting) { e.preventDefault(); win.hide(); } });
}
function openOrFocus(win) { if (win && !win.isDestroyed()) { win.show(); win.focus(); } }

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 600, height: 450, show: true,
    title: 'Snap Assistant - Settings', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'renderer.js'), nodeIntegration: true, contextIsolation: false }
  });
  mainWindow.loadFile('index.html');
  installMinimizeToTray(mainWindow);
}

function createChatWindow() {
  chatWindow = new BrowserWindow({
    width: 800, height: 600, show: false,
    title: 'Snap Assistant - Chat', autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  chatWindow.loadFile('chat.html');
  installMinimizeToTray(chatWindow);
  chatWindow.on('closed', () => chatWindow = null);
}

function createResultWindow() {
  resultWindow = new BrowserWindow({
    width: 700, height: 450, show: false, title: 'Snap Assistant', autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  resultWindow.loadFile('result.html');
  installMinimizeToTray(resultWindow);
}

// =============== Overlay & OCR ===============
// One overlay window per monitor, so a region can be picked on any screen.
let overlayWindows = [];
let overlayOpening = false;
const overlayInfo = new WeakMap(); // overlay window -> { display, sourceId, srcBounds }
const isLinux = process.platform === 'linux';

function liveOverlays() { return overlayWindows.filter(w => !w.isDestroyed()); }

function unionBounds(displays) {
  const x = Math.min(...displays.map(d => d.bounds.x)), y = Math.min(...displays.map(d => d.bounds.y));
  const r = Math.max(...displays.map(d => d.bounds.x + d.bounds.width));
  const b = Math.max(...displays.map(d => d.bounds.y + d.bounds.height));
  return { x, y, width: r - x, height: b - y };
}
function sameRect(a, b) { return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height; }

// Decide which capture source shows which monitor, and which desktop area (DIP) it covers.
// Returns Map(display.id -> { source, bounds }).
//  - Windows / X11: one source per monitor, normally matched by display_id. On X11 the id
//    comes from EDID and may not match Electron's, so unmatched ones pair up by shape/order.
//  - Wayland (PipeWire portal): a single source, either one monitor the user picked or the
//    whole desktop ("full workspace"); its aspect ratio tells which.
function mapSourcesToDisplays(sources, displays, cursorDisplay) {
  const result = new Map();
  const usable = sources.filter(s => s.thumbnail && !s.thumbnail.isEmpty());
  const aspectOf = s => { const z = s.thumbnail.getSize(); return z.width / z.height; };
  const close = (a, b) => Math.abs(a - b) / b < 0.02;

  for (const d of displays) {
    const s = usable.find(src => src.display_id && src.display_id === String(d.id));
    if (s) result.set(d.id, { source: s, bounds: d.bounds });
  }
  const used = new Set([...result.values()].map(m => m.source));
  let rest = usable.filter(s => !used.has(s));
  let left = displays.filter(d => !result.has(d.id));
  if (!rest.length || !left.length) return result;

  if (displays.length > 1 && result.size === 0 && rest.length === 1) {
    const desktop = unionBounds(displays);
    const a = aspectOf(rest[0]);
    if (close(a, desktop.width / desktop.height) && !displays.some(d => close(a, d.bounds.width / d.bounds.height))) {
      for (const d of displays) result.set(d.id, { source: rest[0], bounds: desktop });
      return result;
    }
  }

  // Pair the rest: same count -> enumeration order; otherwise closest aspect ratio,
  // preferring the monitor under the cursor (Wayland: the one the user just picked is unknown).
  if (rest.length === left.length) {
    left.forEach((d, i) => result.set(d.id, { source: rest[i], bounds: d.bounds }));
    return result;
  }
  for (const s of rest) {
    if (!left.length) break;
    const a = aspectOf(s);
    const score = d => Math.abs(a - d.bounds.width / d.bounds.height) - (d.id === cursorDisplay.id ? 0.001 : 0);
    const d = left.reduce((best, x) => (score(x) < score(best) ? x : best));
    result.set(d.id, { source: s, bounds: d.bounds });
    left = left.filter(x => x !== d);
  }
  return result;
}

async function openOverlay(mode = 'capture') {
  if (overlayOpening) return;
  if (rec) { notify('Đang quay video — dừng quay trước đã'); return; }
  const open = liveOverlays();
  if (open.length) { (overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : open[0]).focus(); return; }
  overlayOpening = true;
  try {
    const displays = screen.getAllDisplays();
    const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const desktop = unionBounds(displays);
    const maxScale = Math.max(...displays.map(d => d.scaleFactor));
    // Capture at physical resolution so HiDPI screens stay sharp. Thumbnails keep their
    // aspect ratio inside this box; it is big enough for one monitor or for a source that
    // spans the whole desktop (Linux/Wayland can return a single such source).
    const width = Math.round(desktop.width * maxScale);
    const height = Math.round(desktop.height * maxScale);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    const mapping = mapSourcesToDisplays(sources, displays, cursorDisplay);
    log(`Overlay: ${displays.length} màn hình, ${sources.length} nguồn chụp`,
      JSON.stringify(sources.map(s => ({ id: s.id, display_id: s.display_id, size: s.thumbnail.getSize() }))));

    displays.forEach((display) => {
      const m = mapping.get(display.id);
      if (!m) { log(`Overlay: không có ảnh cho màn hình ${display.id}`, JSON.stringify(display.bounds)); return; }
      const { source, bounds: srcBounds } = m;
      let thumb = source.thumbnail;
      // Cut this monitor out when the source covers more than it (whole-desktop source).
      if (!sameRect(srcBounds, display.bounds)) {
        const sz = thumb.getSize();
        const k = sz.width / srcBounds.width;
        thumb = thumb.crop({
          x: Math.round((display.bounds.x - srcBounds.x) * k), y: Math.round((display.bounds.y - srcBounds.y) * k),
          width: Math.round(display.bounds.width * k), height: Math.round(display.bounds.height * k)
        });
      }
      // Thumbnails come back scaled to the shared box; bring them back to native size.
      const nativeW = Math.round(display.size.width * display.scaleFactor);
      const nativeH = Math.round(display.size.height * display.scaleFactor);
      const sz = thumb.getSize();
      if (sz.width !== nativeW || sz.height !== nativeH) {
        thumb = thumb.resize({ width: nativeW, height: nativeH, quality: 'best' });
      }
      const image = thumb.toDataURL();
      // On Linux the window manager places a window that is fullscreen from the start on the
      // primary monitor, so position it first and go fullscreen after it is shown. It must stay
      // resizable there: GTK pins a non-resizable window's size (min = max), and window managers
      // then refuse fullscreen and keep it inside the work area, leaving panels/docks uncovered.
      const win = new BrowserWindow({
        ...display.bounds, fullscreen: !isLinux, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true,
        resizable: isLinux, movable: false, show: false, enableLargerThanScreen: true, fullscreenable: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
      });
      // Re-apply bounds: Windows can mis-size windows created on a monitor with a different DPI.
      win.setBounds(display.bounds);
      win.setAlwaysOnTop(true, 'screen-saver');
      win.on('closed', () => {
        overlayWindows = overlayWindows.filter(w => w !== win);
        if (overlayWindow === win) overlayWindow = null;
      });
      win.loadFile('overlay.html');
      win.webContents.once('did-finish-load', () => {
        win.webContents.send('set-image', image, mode);
        win.show();
        if (isLinux) fullscreenOnDisplay(win, display);
        log(`Overlay: display ${display.id} (scale ${display.scaleFactor})`, JSON.stringify(display.bounds), '-> window', JSON.stringify(win.getBounds()), 'source', source.id, source.display_id || '(none)', JSON.stringify(srcBounds), JSON.stringify(thumb.getSize()));
        if (display.id === cursorDisplay.id) win.focus();
      });
      // The overlay under the cursor gets keyboard focus first; later the one the user clicks.
      win.on('focus', () => { overlayWindow = win; });
      if (display.id === cursorDisplay.id || !overlayWindow) overlayWindow = win;
      overlayInfo.set(win, { display, sourceId: source.id, srcBounds });
      overlayWindows.push(win);
    });
    if (!overlayWindows.length) notify('Không chụp được màn hình nào');
  } finally {
    overlayOpening = false;
  }
}

// Linux: the window manager places a newly shown window itself (often on the primary
// monitor) and fullscreens it on whatever monitor it sits on at that moment. So move it
// onto its monitor, let the move land, and only then go fullscreen; if it still ends up on
// another monitor, leave fullscreen, move it back and try again.
const wait = ms => new Promise(r => setTimeout(r, ms));
function onDisplay(win, display) {
  const b = win.getBounds();
  return screen.getDisplayMatching(b).id === display.id;
}
async function fullscreenOnDisplay(win, display) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (win.isDestroyed()) return;
    if (win.isFullScreen()) {
      win.setFullScreen(false);
      await wait(150);
      if (win.isDestroyed()) return;
    }
    win.setBounds(display.bounds);
    await wait(80 * attempt);
    if (win.isDestroyed()) return;
    win.setFullScreen(true);
    await wait(200);
    if (win.isDestroyed()) return;
    const got = win.getBounds();
    if (win.isFullScreen() && onDisplay(win, display) && sameRect(got, display.bounds)) return;
    log(`Overlay: display ${display.id} lệch chỗ (lần ${attempt})`, JSON.stringify(got), 'fullscreen', win.isFullScreen());
  }
}

function closeOverlay() {
  liveOverlays().forEach(w => w.close());
  overlayWindows = [];
  overlayWindow = null;
}
function hideOverlays() { liveOverlays().forEach(w => w.hide()); }
function showOverlays() { liveOverlays().forEach(w => w.show()); }

function notify(body) {
  if (Notification.isSupported()) new Notification({ title: 'Snap Assistant', body, silent: true }).show();
}

function timestampName() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `Screenshot_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
}

async function ocrDataUrl(dataUrl) {
  const buf = Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64');
  const { data: { text } } = await Tesseract.recognize(buf, 'eng+vie');
  return (text || '').trim();
}

function printImage(dataUrl) {
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  const html = `<!doctype html><html><head><style>
    @page { margin: 10mm; } html,body { margin:0; }
    img { max-width:100%; max-height:100vh; object-fit:contain; display:block; margin:auto; }
  </style></head><body><img src="${dataUrl}"></body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.webContents.once('did-finish-load', () => {
    win.webContents.print({ silent: false, printBackground: true }, (ok, reason) => {
      if (!ok && reason && reason !== 'cancelled') log('Print failed:', reason);
      win.close();
    });
  });
}

// Actions from the Lightshot-style toolbar
ipcMain.handle('overlay-action', async (e, { action, dataUrl } = {}) => {
  if (!dataUrl) return { keepOpen: true, message: 'Không có ảnh' };
  const senderWin = BrowserWindow.fromWebContents(e.sender);
  switch (action) {
    case 'copy': {
      clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
      closeOverlay();
      notify('Đã sao chép ảnh vào clipboard');
      return { ok: true };
    }
    case 'save': {
      // Hide the always-on-top overlay so the dialog is visible; restore on cancel.
      hideOverlays();
      const lastDir = store.get('lastSaveDir') || app.getPath('pictures');
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Lưu ảnh chụp màn hình',
        defaultPath: path.join(lastDir, timestampName()),
        filters: [{ name: 'PNG', extensions: ['png'] }, { name: 'JPEG', extensions: ['jpg', 'jpeg'] }]
      });
      if (canceled || !filePath) {
        showOverlays();
        if (senderWin && !senderWin.isDestroyed()) senderWin.focus();
        return { keepOpen: true };
      }
      const img = nativeImage.createFromDataURL(dataUrl);
      const buf = /\.jpe?g$/i.test(filePath) ? img.toJPEG(92) : img.toPNG();
      await fsp.writeFile(filePath, buf);
      store.set('lastSaveDir', path.dirname(filePath));
      closeOverlay();
      notify(`Đã lưu: ${path.basename(filePath)}`);
      return { ok: true };
    }
    case 'print': {
      closeOverlay();
      printImage(dataUrl);
      return { ok: true };
    }
    case 'search': {
      senderWin?.webContents.send('overlay-toast', '🔍 Đang OCR...');
      const text = await ocrDataUrl(dataUrl);
      if (!text) return { keepOpen: true, message: 'Không nhận diện được văn bản trong vùng chọn' };
      closeOverlay();
      const q = text.replace(/\s+/g, ' ').slice(0, 500);
      await shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(q)}`);
      return { ok: true };
    }
    default:
      return { keepOpen: true, message: `Không hỗ trợ: ${action}` };
  }
});

ipcMain.handle('cancel-overlay', async () => closeOverlay());
ipcMain.handle('region-selected', async (_event, dataUrl) => {
  closeOverlay();
  const base64Data = String(dataUrl || '').replace(/^data:image\/png;base64,/, '');
  const tmpPath = path.join(app.getPath('temp'), 'capture.png');
  await fsp.writeFile(tmpPath, base64Data, 'base64');
  const { data: { text: ocrText } } = await Tesseract.recognize(tmpPath, 'eng+vie');
  if (resultWindow) {
    resultWindow.show();
    resultWindow.webContents.send('screenshot-result', { ocr: ocrText, translation: '⏳ Đang dịch...' });
  }
  const apiKey = store.get('geminiApiKey');
  let translated = '❌ Thiếu API Key';
  if (apiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: `Dịch sang tiếng Việt:\n${ocrText}` }] }] }) });
      const data = await res.json();
      translated = data?.candidates?.[0]?.content?.parts?.[0]?.text || '❌ Không có kết quả';
    } catch (e) { translated = '❌ Lỗi dịch'; }
  }
  if (resultWindow) resultWindow.webContents.send('screenshot-result', { ocr: ocrText, translation: translated });
});

// =============== Region screen recording ===============
// Overlay picks a region -> a hidden recorder window captures that display, crops it and
// encodes it (recorder.js). A click-through frame marks the region; a small bar controls it.
let rec = null; // { capWin, barWin, frameWin, tmpPath, out, ext, stopping }

function toggleRecording() {
  if (rec) return finishRecording('stop');
  return openOverlay('record');
}

function recTimestampName(ext) {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `Recording_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

ipcMain.handle('record-start', async (e, rect) => {
  if (rec) return { keepOpen: true, message: 'Đang quay một video khác' };
  const info = overlayInfo.get(BrowserWindow.fromWebContents(e.sender));
  if (!info || !rect || rect.w < 8 || rect.h < 8) return { keepOpen: true, message: 'Vùng chọn quá nhỏ' };
  closeOverlay();
  // Let the frozen-screenshot overlay disappear before the capture starts.
  await new Promise(r => setTimeout(r, 250));
  try {
    await startRecording(info, rect);
  } catch (err) {
    log('Record start failed:', err);
    discardRecording();
    notify(`Không bắt đầu quay được: ${err.message || err}`);
  }
  return { ok: true };
});

// Reuses the overlay's source (asking again would re-open the screen picker on Wayland).
async function startRecording({ display, sourceId, srcBounds }, rect) {
  const b = display.bounds;
  const region = {
    x: Math.round(b.x + rect.x), y: Math.round(b.y + rect.y),
    width: Math.round(rect.w), height: Math.round(rect.h)
  };

  const tmpPath = path.join(app.getPath('temp'), `snap-recording-${Date.now()}.part`);
  rec = { tmpPath, out: fs.createWriteStream(tmpPath), ext: 'webm', stopping: false };

  // Frame: 4px larger on every side; its 2px border stays outside the captured area.
  const pad = 4;
  const frameBounds = { x: region.x - pad, y: region.y - pad, width: region.width + pad * 2, height: region.height + pad * 2 };
  const frameWin = new BrowserWindow({
    ...frameBounds, transparent: true, frame: false, resizable: false, movable: false, focusable: false,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false, enableLargerThanScreen: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  frameWin.setBounds(frameBounds); // Windows can mis-size windows on a monitor with another DPI
  frameWin.setIgnoreMouseEvents(true);
  frameWin.setAlwaysOnTop(true, 'screen-saver');
  frameWin.loadFile('recframe.html');
  frameWin.once('ready-to-show', () => frameWin.showInactive());
  rec.frameWin = frameWin;

  // Control bar: below the region, else above, else inside its bottom edge.
  const barW = 300, barH = 40, gap = 8;
  let bx = Math.round(region.x + region.width / 2 - barW / 2);
  bx = Math.min(Math.max(bx, b.x), b.x + b.width - barW);
  let by = region.y + region.height + pad + gap;
  if (by + barH > b.y + b.height) by = region.y - pad - gap - barH;
  if (by < b.y) by = region.y + region.height - barH - gap;
  const barBounds = { x: bx, y: by, width: barW, height: barH };
  const barWin = new BrowserWindow({
    ...barBounds, transparent: true, frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true,
    show: false, focusable: false, hasShadow: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  barWin.setBounds(barBounds);
  barWin.setAlwaysOnTop(true, 'screen-saver');
  // Keep the bar out of the video in case it ends up over the region.
  barWin.setContentProtection(true);
  barWin.loadFile('recbar.html');
  barWin.once('ready-to-show', () => barWin.showInactive());
  rec.barWin = barWin;

  const capWin = new BrowserWindow({
    show: false, width: 200, height: 200, skipTaskbar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
  });
  rec.capWin = capWin;
  capWin.loadFile('recorder.html');
  await new Promise(r => capWin.webContents.once('did-finish-load', r));
  if (!rec || rec.capWin !== capWin) return; // cancelled while loading
  capWin.webContents.send('rec-init', {
    sourceId,
    // Region relative to the area the source shows (a whole-desktop source on Wayland).
    crop: { ...rect, x: rect.x + b.x - srcBounds.x, y: rect.y + b.y - srcBounds.y },
    displayWidth: srcBounds.width,
    physW: Math.round(srcBounds.width * display.scaleFactor),
    physH: Math.round(srcBounds.height * display.scaleFactor),
    fps: 30,
    audio: !!store.get('recordAudio', true)
  });
  log('Recording region', JSON.stringify(region), 'on display', display.id, 'source', sourceId);
  buildTrayMenu();
}

function fromRecorder(e) { return !!rec && !!rec.capWin && !rec.capWin.isDestroyed() && e.sender === rec.capWin.webContents; }

ipcMain.on('rec-log', (_e, msg) => log(msg));
ipcMain.on('rec-started', (e, info) => {
  if (!fromRecorder(e)) return;
  rec.ext = info.ext;
  if (rec.barWin && !rec.barWin.isDestroyed()) rec.barWin.webContents.send('rec-started', info);
  tray?.setToolTip('Snap Assistant — đang quay video');
});
ipcMain.on('rec-chunk', (e, bytes) => { if (fromRecorder(e)) rec.out.write(Buffer.from(bytes)); });
ipcMain.on('rec-control', (_e, cmd) => {
  if (!rec) return;
  if (cmd === 'pause' || cmd === 'resume') { if (rec.capWin && !rec.capWin.isDestroyed()) rec.capWin.webContents.send('rec-cmd', cmd); }
  else if (cmd === 'stop' || cmd === 'cancel') finishRecording(cmd);
});
ipcMain.on('rec-error', (e, msg) => {
  if (!fromRecorder(e)) return;
  log('Recorder error:', msg);
  discardRecording();
  notify(`Lỗi quay video: ${msg}`);
});
ipcMain.on('rec-cancelled', (e) => {
  if (!fromRecorder(e)) return;
  discardRecording();
  notify('Đã huỷ quay video');
});
ipcMain.on('rec-finished', async (e) => {
  if (!fromRecorder(e)) return;
  const { tmpPath, ext } = rec;
  await teardownRecording();
  await saveRecording(tmpPath, ext);
});

function finishRecording(cmd) {
  if (!rec || rec.stopping) return;
  rec.stopping = true;
  // Hide the frame/bar right away; the recorder flushes and reports back.
  [rec.frameWin, rec.barWin].forEach(w => { if (w && !w.isDestroyed()) w.hide(); });
  if (rec.capWin && !rec.capWin.isDestroyed()) rec.capWin.webContents.send('rec-cmd', cmd);
  else discardRecording();
}

async function discardRecording() {
  const tmp = rec?.tmpPath;
  await teardownRecording();
  if (tmp) await fsp.unlink(tmp).catch(() => {});
}

// Closes the recording windows; resolves once the temp file is fully flushed.
function teardownRecording() {
  if (!rec) return Promise.resolve();
  const r = rec;
  rec = null;
  [r.frameWin, r.barWin, r.capWin].forEach(w => { if (w && !w.isDestroyed()) w.destroy(); });
  tray?.setToolTip('Snap Assistant');
  buildTrayMenu();
  return new Promise(resolve => r.out ? r.out.end(resolve) : resolve());
}

async function saveRecording(tmpPath, ext) {
  const lastDir = store.get('lastVideoDir') || app.getPath('videos');
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Lưu video quay màn hình',
    defaultPath: path.join(lastDir, recTimestampName(ext)),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  });
  if (canceled || !filePath) {
    await fsp.unlink(tmpPath).catch(() => {});
    notify('Đã bỏ video vừa quay');
    return;
  }
  try {
    await fsp.rename(tmpPath, filePath).catch(async () => {
      await fsp.copyFile(tmpPath, filePath); // different drive
      await fsp.unlink(tmpPath).catch(() => {});
    });
    store.set('lastVideoDir', path.dirname(filePath));
    if (Notification.isSupported()) {
      const n = new Notification({ title: 'Snap Assistant', body: `Đã lưu video: ${path.basename(filePath)} — bấm để mở thư mục`, silent: true });
      n.on('click', () => shell.showItemInFolder(filePath));
      n.show();
    }
  } catch (err) {
    log('Save recording failed:', err);
    notify(`Không lưu được video: ${err.message}`);
  }
}

// =============== Tray ===============
function buildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const u = updater.getState();
  const updateItem =
    u.status === 'ready' ? { label: `Khởi động lại để cập nhật lên ${u.version}`, click: () => updater.installNow() } :
    u.status === 'downloading' ? { label: `Đang tải bản ${u.version}... ${u.percent}%`, enabled: false } :
    u.status === 'available' ? { label: `Tải bản mới ${u.version}`, click: () => shell.openExternal(updater.RELEASES_URL) } :
    { label: 'Kiểm tra cập nhật', click: () => updater.checkForUpdates({ manual: true }).then(showManualCheckResult) };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Chụp màn hình', click: () => openOverlay('capture') },
    { label: 'OCR & Dịch', click: () => openOverlay('ocr') },
    rec ? { label: '⏹ Dừng quay & lưu video', click: () => finishRecording('stop') }
        : { label: 'Quay video vùng chọn', click: () => openOverlay('record') },
    { label: 'Chat với AI', click: () => { if (!chatWindow) createChatWindow(); openOrFocus(chatWindow); } },
    { label: 'Mở Settings', click: () => openOrFocus(mainWindow) },
    { type: 'separator' },
    updateItem,
    { label: `Phiên bản ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'Thoát', click: () => { app.isQuiting = true; app.quit(); } }
  ]));
}

function showManualCheckResult(u) {
  if (u.status === 'latest') notify(`Bạn đang dùng bản mới nhất (${u.current}).`);
  else if (u.status === 'error') notify(`Không kiểm tra được cập nhật: ${u.error}`);
}

// =============== App Lifecycle ===============
app.whenReady().then(() => {
  createMainWindow();
  createChatWindow();
  createResultWindow();

  tray = new Tray(path.join(__dirname, 'icon.png'));
  tray.setToolTip('Snap Assistant');
  buildTrayMenu();

  updater.init({ log, store, notify, onStateChange: buildTrayMenu });

  registerAllHotkeys();

  log('App ready');
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (rec) { const tmp = rec.tmpPath; teardownRecording(); try { fs.unlinkSync(tmp); } catch (_) {} }
});
