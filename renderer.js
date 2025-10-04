// renderer.js — compact settings dialog
const { ipcRenderer } = require('electron');

const $ = (id) => document.getElementById(id);
const apiKeyInput = $('apiKeyInput');
const hotkeyInput = $('hotkeyInput');
const autoLaunchToggle = $('autoLaunchToggle');
const autoLaunchHiddenToggle = $('autoLaunchHiddenToggle');
const singleCaptureToggle = $('singleCaptureToggle');
const btnApply = $('btnApply');
const btnDefault = $('btnDefault');
const btnClose = $('btnClose');
const statusEl = $('status');

function setStatus(msg, ok = true, ttl = 1600) {
  statusEl.textContent = msg || '';
  statusEl.classList.remove('ok', 'err');
  if (msg) statusEl.classList.add(ok ? 'ok' : 'err');
  if (ttl) setTimeout(() => (statusEl.textContent = ''), ttl);
}

async function loadInitial() {
  try {
    apiKeyInput.value = (await ipcRenderer.invoke('get-api-key')) || '';
    hotkeyInput.value = (await ipcRenderer.invoke('get-hotkey')) || 'CommandOrControl+Shift+S';

    const auto = await ipcRenderer.invoke('get-auto-launch');
    autoLaunchToggle.checked = !!(auto && auto.enabled);
    autoLaunchHiddenToggle.checked = true; // mặc định ẩn khi khởi động

    singleCaptureToggle.checked = !!(await ipcRenderer.invoke('get-single-capture'));
  } catch (e) {
    console.error(e);
    setStatus('Không tải được cấu hình', false, 2500);
  }
}

async function applyAll() {
  try {
    // 1) API Key
    await ipcRenderer.invoke('save-api-key', apiKeyInput.value.trim());

    // 2) Hotkey
    const okHotkey = await ipcRenderer.invoke('save-hotkey', hotkeyInput.value.trim());
    if (!okHotkey) return setStatus('Không đăng ký được phím tắt', false, 3000);

    // 3) Autostart
    const enable = !!autoLaunchToggle.checked;
    const openHidden = !!autoLaunchHiddenToggle.checked;
    const okAuto = await ipcRenderer.invoke('set-auto-launch', { enable, openHidden });
    if (!okAuto) return setStatus('Thiết lập khởi động thất bại', false, 3000);

    // 4) Single-file capture
    const okSingle = await ipcRenderer.invoke('set-single-capture', !!singleCaptureToggle.checked);
    if (!okSingle) return setStatus('Không áp dụng được chế độ 1 file', false, 3000);

    setStatus('Đã áp dụng ✓', true);
  } catch (e) {
    console.error(e);
    setStatus('Áp dụng thất bại', false, 3000);
  }
}

function setDefaultsOnlyInUI() {
  // Chỉ đặt lại form; nhấn "Áp dụng" mới ghi xuống main
  apiKeyInput.value = '';
  hotkeyInput.value = 'CommandOrControl+Shift+S';
  autoLaunchToggle.checked = false;
  autoLaunchHiddenToggle.checked = true;
  singleCaptureToggle.checked = true;
  setStatus('Đã đưa về mặc định (chưa lưu)', true, 2000);
}

btnApply.addEventListener('click', applyAll);
btnDefault.addEventListener('click', setDefaultsOnlyInUI);
btnClose.addEventListener('click', () => window.close());

document.addEventListener('DOMContentLoaded', loadInitial);
