// main.js — Snap Assistant with: local HTTP tessdata server + single-file capture + autostart + detailed logging
const {
  app, BrowserWindow, ipcMain, desktopCapturer, screen,
  globalShortcut, Tray, Menu
} = require('electron');

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const zlib = require('zlib');
const os = require('os');
const Tesseract = require('tesseract.js');

// electron-store: tương thích cả default export và CJS
const StoreMod = require('electron-store');
const Store = StoreMod?.default || StoreMod;
const store = new Store();

// node-fetch v3 (ESM) → lazy import wrapper cho CJS
const fetch = (...args) => import('node-fetch').then(({ default: _fetch }) => _fetch(...args));

// ========================= Globals =========================
let mainWindow;     // Settings
let resultWindow;   // OCR + Translate result
let overlayWindow;  // Overlay chọn vùng
let tray;

let tessdataDir = '';     // thư mục chứa *.traineddata thực tế
let tessServer = null;    // http.Server
let tessBaseURL = '';     // ví dụ: http://127.0.0.1:54321/
let initialShowWindows = true; // ẩn khi khởi động cùng hệ thống nếu mở với --hidden

// ========================= Logger =========================
let logStream = null;
function ts() { return new Date().toISOString(); }
function safeJson(v) { try { return JSON.stringify(v); } catch { return String(v); } }
function write(level, msg, data) {
  const line = `[${ts()}][${process.pid}][${level}] ${msg}${data !== undefined ? ` | ${safeJson(data)}` : ''}\n`;
  if (logStream) logStream.write(line);
  (level === 'ERROR' ? console.error : console.log)(line.trim());
}
const log = {
  info: (m, d) => write('INFO', m, d),
  warn: (m, d) => write('WARN', m, d),
  error: (m, d) => write('ERROR', m, d),
  step: (m, d) => write('STEP', m, d),
  perf: (m, d) => write('PERF', m, d),
};
function ensureLogStream() {
  try {
    const userData = app.getPath('userData');
    const logDir = path.join(userData, 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const logPath = path.join(logDir, `app-${yyyy}-${mm}-${dd}.log`);
    if (!logStream || logStream.path !== logPath) {
      if (logStream) logStream.end();
      logStream = fs.createWriteStream(logPath, { flags: 'a', encoding: 'utf8' });
    }
    return logPath;
  } catch (e) {
    console.error('Logger init error:', e);
    return null;
  }
}
// Cho renderer/overlay gửi log về (tuỳ chọn)
ipcMain.on('log', (_evt, { level = 'INFO', msg = '', data = undefined } = {}) => {
  write(level.toUpperCase(), `renderer: ${msg}`, data);
});

// Bắt lỗi toàn cục
process.on('uncaughtException', (err) => log.error('uncaughtException', { message: err?.message, stack: err?.stack }));
process.on('unhandledRejection', (reason) => log.error('unhandledRejection', { reason: safeJson(reason) }));
app.on('render-process-gone', (_e, details) => log.error('render-process-gone', details));
app.on('child-process-gone', (_e, details) => log.error('child-process-gone', details));
app.on('gpu-process-crashed', (_e, killed) => log.error('gpu-process-crashed', { killed }));

// ========================= Tessdata Resolver =========================
const NEED_LANGS = ['eng.traineddata', 'vie.traineddata'];
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const hasAllFiles = (dir) => NEED_LANGS.every(n => exists(path.join(dir, n)));
const isAsarPath = (p) => String(p).includes('app.asar');

function tessdataCandidates() {
  // Lưu ý: khi packaged, __dirname thường nằm trong app.asar
  const dev = path.join(__dirname, 'tessdata');
  const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'tessdata'); // asarUnpack
  const extraRes = path.join(process.resourcesPath, 'tessdata');                       // extraResources
  const insideAsar = path.join(process.resourcesPath, 'app.asar', 'tessdata');         // ❌ không dùng trực tiếp làm langPath

  if (!app.isPackaged) return [dev, unpacked, extraRes];
  return [unpacked, extraRes, dev, insideAsar];
}

async function copyLangsIfMissing(srcDir, dstDir) {
  let copiedAny = false;
  await fsp.mkdir(dstDir, { recursive: true }).catch(() => {});
  for (const name of NEED_LANGS) {
    const from = path.join(srcDir, name);
    const to = path.join(dstDir, name);
    if (!exists(to) && exists(from)) {
      try {
        await fsp.copyFile(from, to);
        copiedAny = true;
        log.step('tessdata copied', { from, to });
      } catch (e) {
        log.warn('tessdata copy failed', { from, to, message: e?.message });
      }
    }
  }
  return copiedAny;
}

// Trả về thư mục tessdata an toàn (không nằm trong app.asar). Nếu cần, copy ra userData.
async function resolveSafeTessdataPath() {
  const cands = tessdataCandidates();

  // 1) Ưu tiên thư mục đủ file và KHÔNG trong asar
  for (const c of cands) {
    if (c && exists(c) && hasAllFiles(c) && !isAsarPath(c)) {
      log.step('tessdata path selected (fs)', { path: c });
      return c;
    }
  }

  // 2) Nếu chỉ có trong asar/dev-as-asar → copy ra userData/tessdata
  const dst = path.join(app.getPath('userData'), 'tessdata');
  for (const c of cands) {
    if (c && exists(c) && (hasAllFiles(c) || NEED_LANGS.some(n => exists(path.join(c, n))))) {
      await copyLangsIfMissing(c, dst);
    }
  }
  if (hasAllFiles(dst)) {
    log.step('tessdata path selected (userData)', { path: dst });
    return dst;
  }

  // 3) Cuối cùng: vẫn trả dst (để người dùng tự bỏ file vào), kèm cảnh báo
  log.warn('tessdata not found; please ensure files exist', { expectedAt: dst, need: NEED_LANGS });
  return dst;
}

// ========================= Local HTTP server for tessdata =========================
// Phục vụ cả "*.traineddata" và "*.traineddata.gz" (nếu .gz không có, gzip on-the-fly)
function startTessdataServer(rootDir) {
  return new Promise((resolve, reject) => {
    const rootResolved = path.resolve(rootDir);

    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, 'http://127.0.0.1');
        const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
        const abs = path.resolve(path.join(rootResolved, rel));

        // Chặn path traversal
        if (!abs.startsWith(rootResolved)) {
          res.statusCode = 403; return res.end('Forbidden');
        }

        const askGz = rel.endsWith('.traineddata.gz');
        const askPlain = rel.endsWith('.traineddata');

        if (!askGz && !askPlain) {
          res.statusCode = 404; return res.end('Not found');
        }

        if (askGz) {
          const gzPath = abs;
          const plainPath = abs.slice(0, -3); // bỏ ".gz"

          if (fs.existsSync(gzPath)) {
            fs.stat(gzPath, (err, st) => {
              if (err || !st.isFile()) { res.statusCode = 404; return res.end('Not found'); }
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/octet-stream');
              res.setHeader('Content-Length', st.size);
              fs.createReadStream(gzPath).pipe(res);
            });
          } else if (fs.existsSync(plainPath)) {
            fs.readFile(plainPath, (err, buf) => {
              if (err) { res.statusCode = 500; return res.end('Read error'); }
              zlib.gzip(buf, (e2, gz) => {
                if (e2) { res.statusCode = 500; return res.end('Gzip error'); }
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/octet-stream');
                res.setHeader('Content-Length', gz.length);
                res.end(gz);
              });
            });
          } else {
            res.statusCode = 404; res.end('Not found');
          }
          return;
        }

        // .traineddata (không .gz)
        fs.stat(abs, (err, st) => {
          if (err || !st.isFile()) { res.statusCode = 404; return res.end('Not found'); }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Content-Length', st.size);
          fs.createReadStream(abs).pipe(res);
        });

      } catch (e) {
        res.statusCode = 500; res.end('Server error');
      }
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseURL: `http://127.0.0.1:${port}/` });
    });
  });
}

// ========================= Helpers (windows, capture paths) =========================
function installMinimizeToTray(win) {
  if (!win) return;
  win.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      win.hide();
      log.step('window.hide (minimize to tray)', { title: win.getTitle() });
    }
  });
}
function openOrFocus(win) { if (!win || win.isDestroyed()) return; win.show(); win.focus(); }

// --- Capture path helpers ---
// 1 file duy nhất trong thư mục tạm hệ thống
function fixedCapturePath() {
  const safeName = app.getName().replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  return path.join(app.getPath('temp'), `${safeName}-capture.png`);
}
// fallback: tên theo timestamp
function uniqueCapturePath() {
  return path.join(app.getPath('temp'), `screenshot-${Date.now()}.png`);
}
// Ghi đè an toàn: viết ra .tmp rồi rename → tránh file bị đọc dở
async function writeAtomicBase64(target, base64) {
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, base64, 'base64');
  try {
    await fsp.rename(tmp, target);
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'EPERM') {
      try { await fsp.unlink(target); } catch {}
      await fsp.rename(tmp, target);
    } else {
      throw err;
    }
  }
}

// ========================= Auto-Launch at Login (Win/macOS/Linux) =========================
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

function linuxAutostartDesktopPath() {
  const dir = path.join(os.homedir(), '.config', 'autostart');
  return path.join(dir, 'snap-assistant.desktop');
}
function getAutoLaunchStatus() {
  if (isWin || isMac) {
    const s = app.getLoginItemSettings ? app.getLoginItemSettings() : { openAtLogin: false };
    return { enabled: !!s.openAtLogin };
  }
  // Linux: check .desktop exists
  return { enabled: exists(linuxAutostartDesktopPath()) };
}
async function setAutoLaunch(enable, openHidden) {
  try {
    if (isWin || isMac) {
      const args = [];
      if (openHidden && isWin) args.push('--hidden');
      app.setLoginItemSettings({
        openAtLogin: !!enable,
        openAsHidden: isMac ? !!openHidden : undefined,
        path: process.execPath,
        args
      });
      return true;
    } else {
      // Linux: tạo/xoá ~/.config/autostart/snap-assistant.desktop
      const desktopDir = path.dirname(linuxAutostartDesktopPath());
      await fsp.mkdir(desktopDir, { recursive: true }).catch(() => {});
      const execCmd = `"${process.execPath}"${openHidden ? ' --hidden' : ''}`;
      const content =
`[Desktop Entry]
Type=Application
Version=1.0
Name=Snap Assistant
Comment=Start Snap Assistant on login
Exec=${execCmd}
X-GNOME-Autostart-enabled=true
NoDisplay=false
Terminal=false
`;
      if (enable) {
        await fsp.writeFile(linuxAutostartDesktopPath(), content, 'utf8');
      } else {
        if (exists(linuxAutostartDesktopPath())) await fsp.unlink(linuxAutostartDesktopPath()).catch(() => {});
      }
      return true;
    }
  } catch (e) {
    log.error('setAutoLaunch failed', { message: e?.message });
    return false;
  }
}

// ========================= Windows =========================
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 530, height: 261, show: initialShowWindows, title: 'Snap Assistant - Settings', autoHideMenuBar: true,  
    webPreferences: { preload: path.join(__dirname, 'renderer.js'), nodeIntegration: true, contextIsolation: false }
  });
  mainWindow.loadFile('index.html');
  installMinimizeToTray(mainWindow);
  log.step('Main window created');
}
function createResultWindow() {
  resultWindow = new BrowserWindow({
    width: 700, height: 450, show: false, title: 'Snap Assistant', autoHideMenuBar: true,  
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  resultWindow.loadFile('result.html');
  installMinimizeToTray(resultWindow);
  log.step('Result window created');
}

// ========================= Hotkey =========================
function registerHotkey(accelerator) {
  globalShortcut.unregisterAll();
  if (!accelerator) return false;
  const ok = globalShortcut.register(accelerator, () => {
    log.step('Hotkey pressed', { accelerator });
    openOverlay().catch(err => log.error('openOverlay() error', { message: err?.message, stack: err?.stack }));
  });
  log.info(ok ? `Hotkey registered: ${accelerator}` : `Hotkey FAILED: ${accelerator}`);
  return ok;
}

// ========================= App lifecycle =========================
app.whenReady().then(async () => {
  const logPath = ensureLogStream();

  // Ẩn cửa sổ nếu app được mở khi đăng nhập hoặc chạy với --hidden
  let wasOpenedAtLogin = false;
  try {
    if (isWin || isMac) {
      const s = app.getLoginItemSettings?.() || {};
      wasOpenedAtLogin = !!s.wasOpenedAtLogin || !!s.openAtLogin;
    }
  } catch {}
  const startHidden = wasOpenedAtLogin || process.argv.includes('--hidden');
  initialShowWindows = !startHidden;
  log.step('Startup visibility', { wasOpenedAtLogin, argvHidden: process.argv.includes('--hidden'), startHidden });

  // 1) Chọn thư mục tessdata an toàn (không app.asar) + copy nếu cần
  tessdataDir = await resolveSafeTessdataPath();

  // 2) Mở HTTP server cục bộ phục vụ traineddata
  const srv = await startTessdataServer(tessdataDir);
  tessServer = srv.server;
  tessBaseURL = srv.baseURL; // dùng cái này làm langPath
  log.step('tessdata HTTP server started', { baseURL: tessBaseURL, dir: tessdataDir });

  // Log chế độ lưu ảnh OCR
  const singleCapture = store.get('singleCapture', true); // mặc định: true (single file)
  log.step('Capture mode', {
    mode: singleCapture ? 'single' : 'unique-per-run',
    singlePath: singleCapture ? fixedCapturePath() : null
  });

  // Log trạng thái autostart hiện tại
  const auto = getAutoLaunchStatus();
  log.step('Autostart status', auto);

  log.step('App ready', {
    platform: process.platform,
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    cpu: os.cpus()?.[0]?.model,
    logPath,
    tessdataDir,
    tessBaseURL
  });

  if (process.platform === 'win32') app.setAppUserModelId(process.execPath);

  createMainWindow();
  createResultWindow();

  // Tray
  try {
    const trayIcon = path.join(__dirname, 'icon.png');
    tray = new Tray(trayIcon);
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Chụp màn hình', click: () => openOverlay() },
      { label: 'Mở Settings', click: () => openOrFocus(mainWindow) },
      { type: 'separator' },
      { label: 'Thoát', click: () => { app.isQuiting = true; app.quit(); } }
    ]);
    tray.setToolTip('Snap Assistant');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => {
      if (!mainWindow) return;
      if (mainWindow.isVisible()) mainWindow.hide();
      else openOrFocus(mainWindow);
    });
    log.step('Tray initialized');
  } catch (e) {
    log.error('Tray init failed', { message: e?.message });
  }

  const savedHotkey = store.get('hotkey') || 'CommandOrControl+Shift+S';
  registerHotkey(savedHotkey);
});

app.on('window-all-closed', (e) => { e.preventDefault(); log.info('Prevent quit on window-all-closed'); });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) { createMainWindow(); createResultWindow(); }
  else { openOrFocus(mainWindow); }
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (tessServer) {
    try { tessServer.close(); log.step('tessdata HTTP server closed'); } catch {}
  }
  log.step('App will-quit: unregistered all hotkeys');
});

// ========================= API Key / Hotkey / Capture-mode / Autostart IPC =========================
ipcMain.handle('save-api-key', (_e, key) => {
  const trimmed = String(key || '').trim();
  if (trimmed) { store.set('geminiApiKey', trimmed); log.step('API key saved'); return true; }
  store.delete('geminiApiKey'); log.step('API key cleared'); return false;
});
ipcMain.handle('get-api-key', () => store.get('geminiApiKey') || '');
ipcMain.handle('save-hotkey', (_e, hotkey) => {
  const trimmed = String(hotkey || '').trim();
  if (!trimmed) return false;
  store.set('hotkey', trimmed);
  const ok = registerHotkey(trimmed);
  log.step('Hotkey updated', { hotkey: trimmed, ok });
  return ok;
});
ipcMain.handle('get-hotkey', () => store.get('hotkey') || 'CommandOrControl+Shift+S');

// Single-file capture toggle
ipcMain.handle('get-single-capture', () => !!store.get('singleCapture', true));
ipcMain.handle('set-single-capture', (_e, on) => {
  store.set('singleCapture', !!on);
  log.step('Single capture toggled', { enabled: !!on, path: fixedCapturePath() });
  return !!on;
});

// Autostart toggles
ipcMain.handle('get-auto-launch', () => {
  const s = getAutoLaunchStatus();
  return { enabled: !!s.enabled };
});
ipcMain.handle('set-auto-launch', async (_e, { enable, openHidden = true } = {}) => {
  const ok = await setAutoLaunch(!!enable, !!openHidden);
  log.step('Autostart updated', { enable: !!enable, openHidden: !!openHidden, ok });
  return ok;
});

// ========================= Fallback dịch =========================
async function fallbackTranslate(text) {
  try {
    log.step('Translate fallback start (LibreTranslate)');
    const res = await fetch('https://libretranslate.de/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source: 'auto', target: 'vi', format: 'text' })
    });
    const status = res.status;
    const data = await res.json().catch(() => ({}));
    const translated = data.translatedText || '';
    log.step('Translate fallback done', { status, hasText: !!translated });
    return translated || '❌ LibreTranslate không trả về kết quả.';
  } catch (err) {
    log.error('Translate fallback error', { message: err?.message, stack: err?.stack });
    return '❌ Không dịch được (fallback lỗi).';
  }
}

// ========================= Overlay & Capture =========================
async function openOverlay() {
  log.step('Open overlay start');
  const t0 = Date.now();

  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size || display.workAreaSize || { width: 0, height: 0 };
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  }).catch(err => {
    log.error('desktopCapturer.getSources failed', { message: err?.message });
    return [];
  });

  log.info('desktopCapturer sources', { count: sources.length });
  const image = sources[0]?.thumbnail?.toDataURL();
  if (!image) {
    log.error('No screen image from desktopCapturer');
    if (resultWindow && !resultWindow.isDestroyed()) {
      resultWindow.show();
      resultWindow.webContents.send('screenshot-result', {
        ocr: '',
        translation: '❌ Không lấy được ảnh màn hình.'
      });
    }
    return;
  }

  overlayWindow = new BrowserWindow({
    fullscreen: true,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'overlay.js'),
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  overlayWindow.on('closed', () => log.step('Overlay window closed'));
  overlayWindow.loadFile('overlay.html');
  overlayWindow.webContents.once('did-finish-load', () => {
    overlayWindow?.webContents.send('set-image', image);
    log.step('Overlay image injected');
  });
  log.perf('Open overlay done', { ms: Date.now() - t0 });
}

ipcMain.handle('cancel-overlay', async () => {
  log.step('Overlay canceled by user');
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
  overlayWindow = null;
});

// ========================= Region → OCR → Translate =========================
ipcMain.handle('region-selected', async (_event, dataUrl) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
  overlayWindow = null;

  log.step('Region selected received', { hasDataUrl: !!dataUrl });
  let tmpPath;
  const pipelineStart = Date.now();

  try {
    // Save temp image (single-file overwrite hoặc unique file)
    const base64Data = String(dataUrl || '').replace(/^data:image\/png;base64,/, '');
    const singleCapture = store.get('singleCapture', true);
    tmpPath = singleCapture ? fixedCapturePath() : uniqueCapturePath();

    if (singleCapture) {
      await writeAtomicBase64(tmpPath, base64Data);
      log.step('Capture saved (single mode overwrite)', {
        tmpPath,
        sizeBytes: Buffer.byteLength(base64Data, 'base64')
      });
    } else {
      await fsp.writeFile(tmpPath, base64Data, 'base64');
      log.step('Capture saved (unique file)', {
        tmpPath,
        sizeBytes: Buffer.byteLength(base64Data, 'base64')
      });
    }

    // Đảm bảo HTTP server vẫn còn (phòng trường hợp gián đoạn)
    if (!tessServer || !tessBaseURL) {
      log.warn('tessdata server missing; restarting...');
      const srv = await startTessdataServer(tessdataDir);
      tessServer = srv.server;
      tessBaseURL = srv.baseURL;
      log.step('tessdata HTTP server restarted', { baseURL: tessBaseURL, dir: tessdataDir });
    }

    // OCR
    const ocrStart = Date.now();
    log.step('OCR start', { tessdataDir, tessBaseURL, langs: 'eng+vie' });

    const { data: { text: ocrText } } = await Tesseract.recognize(tmpPath, 'eng+vie', {
      // 🔑 DÙNG URL tuyệt đối thay vì đường dẫn file
      langPath: tessBaseURL,
      logger: (m) => {
        // Đẩy tiến trình ra UI
        resultWindow?.webContents.send('ocr-progress', m);

        // ↳ Log rõ khi loading traineddata
        if (m.status === 'loading language traineddata') {
          log.step('Loading traineddata', {
            langPathURL: tessBaseURL,
            localDir: tessdataDir,
            langs: 'eng+vie',
            expectedFiles: NEED_LANGS.map(f => path.join(tessdataDir, f))
          });
        }

        if (m.status === 'recognizing text') {
          const p = Math.round((m.progress || 0) * 100);
          if (p % 10 === 0) log.info(`OCR progress ${p}%`);
        } else {
          log.info(`OCR status: ${m.status}`);
        }
      }
    });

    log.perf('OCR done', { ms: Date.now() - ocrStart, length: ocrText?.length || 0 });

    // Gửi OCR ra UI trước
    if (resultWindow && !resultWindow.isDestroyed()) {
      resultWindow.show();
      resultWindow.webContents.send('screenshot-result', {
        ocr: ocrText,
        translation: '⏳ Đang dịch...'
      });
      log.step('Result window updated (OCR)');
    }

    // Translate (Gemini) + fallback
    let translated = '';
    const currentKey = store.get('geminiApiKey');
    if (!currentKey) {
      translated = '❌ Lỗi: Chưa cấu hình Gemini API Key.';
      log.warn('Translate skipped: missing Gemini API key');
    } else {
      try {
        const tStart = Date.now();
        log.step('Translate (Gemini) start');

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${currentKey}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: `Dịch văn bản sau sang tiếng Việt:\n${ocrText}` }] }]
          })
        });

        const status = res.status;
        let data = null; try { data = await res.json(); } catch { data = null; }

        if (!res.ok) {
          log.error('Gemini HTTP error', { status, data });
          translated = `❌ Lỗi từ Gemini (HTTP ${status})`;
        } else if (data?.error) {
          log.error('Gemini API error', { error: data.error });
          translated = `❌ Lỗi từ Gemini: ${JSON.stringify(data.error)}`;
        } else {
          translated = data?.candidates?.[0]?.content?.parts?.[0]?.text || '❌ Không có kết quả dịch.';
          log.perf('Translate (Gemini) done', { ms: Date.now() - tStart, ok: !!translated });
        }
      } catch (err) {
        log.error('Gemini request exception', { message: err?.message, stack: err?.stack });
        translated = await fallbackTranslate(ocrText);
      }
    }

    // Cập nhật bản dịch
    if (resultWindow && !resultWindow.isDestroyed()) {
      resultWindow.webContents.send('screenshot-result', { ocr: ocrText, translation: translated });
      log.step('Result window updated (Translation)');
    }

  } catch (err) {
    log.error('Region pipeline failed', { message: err?.message, stack: err?.stack });
    if (resultWindow && !resultWindow.isDestroyed()) {
      resultWindow.show();
      resultWindow.webContents.send('screenshot-result', {
        ocr: '',
        translation: '❌ Có lỗi xảy ra trong quá trình OCR/Dịch.'
      });
      log.step('Result window updated (Error)');
    }
  } finally {
    // Dọn file tạm: chỉ xoá nếu KHÔNG ở chế độ single-file
    const singleCapture = store.get('singleCapture', true);
    if (!singleCapture) {
      try {
        // tmpPath có thể trùng fixedCapturePath() → chỉ xoá khi unique
        const isUnique = !singleCapture && tmpPath && !tmpPath.endsWith('-capture.png');
        if (isUnique) {
          await fsp.unlink(tmpPath);
          log.info('Temp image deleted', { tmpPath });
        }
      } catch (e) {
        log.warn('Temp image delete failed', { tmpPath, message: e?.message });
      }
    }
    log.perf('Region pipeline total', { ms: Date.now() - pipelineStart });
  }
});
