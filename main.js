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





ipcMain.handle('get-hotkey', () => store.get('hotkey') || 'CommandOrControl+Shift+S');
ipcMain.handle('save-hotkey', (_e, hotkey) => {
  const h = String(hotkey || '').trim();
  if (!h) return false;
  store.set('hotkey', h);
  globalShortcut.unregisterAll();
  globalShortcut.register(h, () => openOverlay().catch(console.error));
  return true;
});

ipcMain.handle('get-single-capture', () => !!store.get('singleCapture', true));
ipcMain.handle('set-single-capture', (_e, on) => { store.set('singleCapture', !!on); return !!on; });

// 🔥 HANDLER MỚI CHO PHÍM TẮT CHAT
ipcMain.handle('get-chat-hotkey', () => store.get('chatHotkey', 'CommandOrControl+Shift+C'));
ipcMain.handle('save-chat-hotkey', (_e, hotkey) => {
  const oldHotkey = store.get('chatHotkey');
  const newHotkey = String(hotkey || '').trim();

  // Bỏ đăng ký phím tắt cũ
  if (oldHotkey) globalShortcut.unregister(oldHotkey);

  if (!newHotkey) {
    store.delete('chatHotkey');
    return true;
  }

  // Đăng ký phím tắt mới
  const registered = globalShortcut.register(newHotkey, () => {
    if (!chatWindow) createChatWindow();
    openOrFocus(chatWindow);
  });
  
  if (registered) {
    store.set('chatHotkey', newHotkey);
    log(`Phím tắt Chat mới đã đăng ký: ${newHotkey}`);
    return true;
  } else {
    log(`❌ Lỗi đăng ký phím tắt Chat: ${newHotkey}`);
    // Đăng ký lại phím tắt cũ nếu có lỗi
    if (oldHotkey) globalShortcut.register(oldHotkey, () => {
        if (!chatWindow) createChatWindow();
        openOrFocus(chatWindow);
    });
    return false;
  }
});

log('✅ IPC handlers registered');

// =============== Window Helpers ===============
function installMinimizeToTray(win) {
  win.on('close', (e) => { if (!app.isQuiting) { e.preventDefault(); win.hide(); } });
}
function openOrFocus(win) { if (win && !win.isDestroyed()) { win.show(); win.focus(); } }

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 600, height: 300, show: true,
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
async function openOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) { overlayWindow.focus(); return; }
  const display = screen.getPrimaryDisplay();
  // Capture at physical resolution so HiDPI screens stay sharp.
  const width = Math.round(display.size.width * display.scaleFactor);
  const height = Math.round(display.size.height * display.scaleFactor);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
  const source = sources.find(s => s.display_id === String(display.id)) || sources[0];
  const image = source?.thumbnail?.toDataURL();
  if (!image) return;
  overlayWindow = new BrowserWindow({
    ...display.bounds, fullscreen: true, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, movable: false, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.on('closed', () => overlayWindow = null);
  overlayWindow.loadFile('overlay.html');
  overlayWindow.webContents.once('did-finish-load', () => {
    overlayWindow.webContents.send('set-image', image);
    overlayWindow.show();
    overlayWindow.focus();
  });
}

function closeOverlay() { if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close(); }

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
ipcMain.handle('overlay-action', async (_e, { action, dataUrl } = {}) => {
  if (!dataUrl) return { keepOpen: true, message: 'Không có ảnh' };
  switch (action) {
    case 'copy': {
      clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
      closeOverlay();
      notify('Đã sao chép ảnh vào clipboard');
      return { ok: true };
    }
    case 'save': {
      // Hide the always-on-top overlay so the dialog is visible; restore on cancel.
      overlayWindow?.hide();
      const lastDir = store.get('lastSaveDir') || app.getPath('pictures');
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Lưu ảnh chụp màn hình',
        defaultPath: path.join(lastDir, timestampName()),
        filters: [{ name: 'PNG', extensions: ['png'] }, { name: 'JPEG', extensions: ['jpg', 'jpeg'] }]
      });
      if (canceled || !filePath) {
        if (overlayWindow) { overlayWindow.show(); overlayWindow.focus(); }
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
      overlayWindow?.webContents.send('overlay-toast', '🔍 Đang OCR...');
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
  if (overlayWindow) overlayWindow.close();
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

// =============== App Lifecycle ===============
app.whenReady().then(() => {
  createMainWindow();
  createChatWindow();
  createResultWindow();

  tray = new Tray(path.join(__dirname, 'icon.png'));
  tray.setToolTip('Snap Assistant');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Chụp màn hình', click: () => openOverlay() },
    { label: 'Chat với AI', click: () => { if (!chatWindow) createChatWindow(); openOrFocus(chatWindow); } },
    { label: 'Mở Settings', click: () => openOrFocus(mainWindow) },
    { type: 'separator' },
    { label: 'Thoát', click: () => { app.isQuiting = true; app.quit(); } }
  ]));

  const hotkey = store.get('hotkey') || 'CommandOrControl+Shift+S';
  globalShortcut.register(hotkey, () => openOverlay().catch(console.error));

  // 🔥 Đăng ký phím tắt Chat (sử dụng giá trị đã lưu)
  const chatHotkey = store.get('chatHotkey', 'CommandOrControl+Shift+C'); // Lấy từ store
  globalShortcut.register(chatHotkey, () => {
    if (!chatWindow) createChatWindow();
    openOrFocus(chatWindow);
  });
  
  if (globalShortcut.isRegistered(chatHotkey)) {
    log(`Phím tắt Chat đã đăng ký: ${chatHotkey}`);
  }

  log('App ready');
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('will-quit', () => globalShortcut.unregisterAll());
