// updater.js — self-update from GitHub Releases.
//
// Installs that can replace themselves (Windows NSIS setup, Linux AppImage / deb)
// use electron-updater: the new version downloads in the background and is
// installed on restart. Builds that cannot (portable .exe, tar.gz, dev runs)
// only check the latest GitHub release and point the user to the download page.

const { app, ipcMain, dialog, shell, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OWNER = 'haunguyen99';
const REPO = 'Snap-Assistan';
const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases/latest`;
const FIRST_CHECK_DELAY = 15 * 1000;
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

let ctx = null;          // { log, store, notify, onStateChange }
let autoUpdater = null;  // electron-updater instance, when self-update is possible
let timer = null;
let state = { status: 'idle', version: null, percent: 0, error: null, manual: false };

// ---------------------------------------------------------------- helpers
function canSelfUpdate() {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') return !process.env.PORTABLE_EXECUTABLE_DIR;
  if (process.platform === 'linux') {
    // AppImage sets $APPIMAGE; deb/rpm builds ship resources/package-type.
    return !!process.env.APPIMAGE || fs.existsSync(path.join(process.resourcesPath, 'package-type'));
  }
  return process.platform === 'darwin';
}

function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function setState(patch) {
  state = { ...state, ...patch };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('update-status', publicState());
  }
  ctx?.onStateChange?.(publicState());
}

function publicState() {
  return { ...state, current: app.getVersion(), selfUpdate: canSelfUpdate(), autoCheck: autoCheckEnabled(), releasesUrl: RELEASES_URL };
}

function autoCheckEnabled() { return ctx ? ctx.store.get('autoUpdate', true) !== false : true; }

// ---------------------------------------------------------------- electron-updater path
function setupAutoUpdater() {
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: (m) => ctx.log('[update]', m), warn: (m) => ctx.log('[update] WARN', m), error: (m) => ctx.log('[update] ERROR', m), debug: () => {} };

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: null }));
  autoUpdater.on('update-not-available', () => setState({ status: 'latest', version: null }));
  autoUpdater.on('update-available', (info) => {
    setState({ status: 'downloading', version: info.version, percent: 0 });
    ctx.notify(`Có bản mới ${info.version}, đang tải về...`);
  });
  autoUpdater.on('download-progress', (p) => setState({ status: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => {
    setState({ status: 'ready', version: info.version, percent: 100 });
    promptRestart(info.version);
  });
  autoUpdater.on('error', (err) => {
    ctx.log('[update] error', err?.message || err);
    setState({ status: 'error', error: friendlyError(err) });
  });
}

function friendlyError(err) {
  const msg = String(err?.message || err || '');
  if (/latest(-linux)?\.yml|404/i.test(msg)) return 'Bản phát hành mới nhất chưa có file cập nhật tự động.';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/i.test(msg)) return 'Không kết nối được tới GitHub.';
  return msg.split('\n')[0].slice(0, 200) || 'Lỗi không xác định';
}

async function promptRestart(version) {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'Snap Assistant',
    message: `Đã tải xong bản ${version}.`,
    detail: 'Khởi động lại để cập nhật ngay, hoặc bản mới sẽ được cài khi bạn thoát app.',
    buttons: ['Khởi động lại', 'Để sau'],
    defaultId: 0,
    cancelId: 1
  });
  if (response === 0) installNow();
}

function installNow() {
  if (!autoUpdater || state.status !== 'ready') return false;
  app.isQuiting = true;
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return true;
}

// ---------------------------------------------------------------- GitHub API path (no self-update)
async function checkGithubLatest() {
  setState({ status: 'checking', error: null });
  try {
    // /releases/latest redirects to /releases/tag/<tag>. Unlike the REST API it has
    // no 60-requests-per-hour limit for anonymous clients.
    const res = await fetch(RELEASES_URL, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': 'snap-assistant-updater' } });
    if (!res.ok) throw new Error(`GitHub trả về ${res.status}`);
    const m = /\/releases\/tag\/([^/?#]+)/.exec(res.url);
    if (!m) throw new Error('Không đọc được phiên bản mới nhất');
    const latest = decodeURIComponent(m[1]).replace(/^v/, '');
    if (latest && cmpVersion(latest, app.getVersion()) > 0) {
      setState({ status: 'available', version: latest });
      if (!state.manual) ctx.notify(`Có bản mới ${latest}. Mở Settings để tải về.`);
    } else {
      setState({ status: 'latest', version: null });
    }
  } catch (err) {
    setState({ status: 'error', error: friendlyError(err) });
  }
}

// ---------------------------------------------------------------- public
async function checkForUpdates({ manual = false } = {}) {
  if (['checking', 'downloading', 'ready'].includes(state.status)) return publicState();
  state.manual = manual;
  if (autoUpdater) {
    try { await autoUpdater.checkForUpdates(); } catch (err) { setState({ status: 'error', error: friendlyError(err) }); }
  } else {
    await checkGithubLatest();
  }
  return publicState();
}

function schedule() {
  clearInterval(timer);
  timer = null;
  if (!autoCheckEnabled() || !app.isPackaged) return;
  timer = setInterval(() => checkForUpdates(), CHECK_INTERVAL);
}

function init({ log, store, notify, onStateChange }) {
  ctx = { log, store, notify, onStateChange };
  if (canSelfUpdate()) setupAutoUpdater();
  log(`[update] ${app.getVersion()}, tự cập nhật: ${canSelfUpdate() ? 'có' : 'không (chỉ báo bản mới)'}`);

  ipcMain.handle('update-get-state', () => publicState());
  ipcMain.handle('update-check', () => checkForUpdates({ manual: true }));
  ipcMain.handle('update-install', () => installNow());
  ipcMain.handle('update-open-releases', () => shell.openExternal(RELEASES_URL));
  ipcMain.handle('update-set-auto', (_e, on) => { store.set('autoUpdate', !!on); schedule(); setState({}); return !!on; });

  // Dev runs don't check automatically (there is nothing to install over).
  if (app.isPackaged && autoCheckEnabled()) setTimeout(() => checkForUpdates(), FIRST_CHECK_DELAY);
  schedule();
}

module.exports = { init, checkForUpdates, installNow, getState: publicState, RELEASES_URL };
