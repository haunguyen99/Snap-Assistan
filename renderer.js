// renderer.js — compact settings dialog
const { ipcRenderer } = require('electron');

const $ = (id) => document.getElementById(id);
const apiKeyInput = $('apiKeyInput');
const HOTKEY_IDS = ['capture', 'ocr', 'record', 'chat'];
let hotkeyDefaults = {};
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
    await loadHotkeys();

    const auto = await ipcRenderer.invoke('get-auto-launch');
    autoLaunchToggle.checked = !!(auto && auto.enabled);
    autoLaunchHiddenToggle.checked = true; // mặc định ẩn khi khởi động

    singleCaptureToggle.checked = !!(await ipcRenderer.invoke('get-single-capture'));
  } catch (e) {
    console.error('Lỗi tải cài đặt ban đầu:', e);
    setStatus('Lỗi tải cài đặt', false, 3000);
  }
}

async function handleApply() {
  setStatus('Đang áp dụng...');
  try {
    // 1) API Key
    await ipcRenderer.invoke('save-api-key', apiKeyInput.value.trim());

    // 2) Phím tắt cho 3 tính năng
    const map = {};
    HOTKEY_IDS.forEach((id) => { map[id] = getHotkeyValue(id); });
    const hk = await ipcRenderer.invoke('save-hotkeys', map);
    await loadHotkeys();
    if (!hk || !hk.ok) return setStatus(hk?.error || 'Không lưu được phím tắt', false, 5000);

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
  HOTKEY_IDS.forEach((id) => setHotkeyValue(id, hotkeyDefaults[id] || ''));
  autoLaunchToggle.checked = false;
  autoLaunchHiddenToggle.checked = true;
  singleCaptureToggle.checked = false;
  setStatus('Đã đặt lại mặc định trên form', true, 1600);
}

// ---------------------------------------------------------------- hotkey recorder
// Values are Electron accelerators ("CommandOrControl+Shift+S"); the field shows "Ctrl + Shift + S".
const CODE_MAP = {
  Space: 'Space', Tab: 'Tab', Enter: 'Enter', Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', PrintScreen: 'PrintScreen',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',Semicolon: ';',
  Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec'
};

function keyFromCode(code) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^Numpad(\d)$/.exec(code))) return `num${m[1]}`;
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return CODE_MAP[code] || null;
}

function prettyAccel(accel) {
  if (!accel) return 'Không dùng';
  return accel.split('+').map((p) => ({ CommandOrControl: 'Ctrl', Control: 'Ctrl', Super: 'Win', Meta: 'Win' }[p] || p)).join(' + ');
}

function setHotkeyValue(id, accel) {
  const el = $(`hk-${id}`);
  el.dataset.accel = accel || '';
  el.value = prettyAccel(accel);
  el.classList.toggle('empty', !accel);
}
function getHotkeyValue(id) { return $(`hk-${id}`).dataset.accel || ''; }

async function loadHotkeys() {
  const all = await ipcRenderer.invoke('get-hotkeys');
  HOTKEY_IDS.forEach((id) => {
    const h = all[id] || {};
    hotkeyDefaults[id] = h.def || '';
    setHotkeyValue(id, h.accel || '');
    const dot = $(`dot-${id}`);
    dot.className = 'dot' + (h.accel ? (h.active ? ' on' : ' off') : '');
    dot.title = !h.accel ? 'Không dùng' : h.active ? 'Đang hoạt động' : 'Không đăng ký được (phím có thể đã bị app khác dùng)';
  });
}

document.querySelectorAll('input.hotkey').forEach((el) => {
  const id = el.dataset.id;
  let before = '';

  const finish = (accel) => {
    setHotkeyValue(id, accel);
    el.blur();
  };

  el.addEventListener('focus', () => {
    before = getHotkeyValue(id);
    el.classList.add('recording');
    el.classList.remove('empty');
    el.value = 'Nhấn tổ hợp phím...';
    ipcRenderer.send('hotkeys-suspend');
  });
  el.addEventListener('blur', () => {
    el.classList.remove('recording');
    if (el.value === 'Nhấn tổ hợp phím...' || el.classList.contains('partial')) setHotkeyValue(id, before);
    el.classList.remove('partial');
    ipcRenderer.send('hotkeys-resume');
  });

  const handle = (e) => {
    e.preventDefault();
    const mods = [];
    if (e.ctrlKey) mods.push('CommandOrControl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');

    if (!mods.length && e.code === 'Escape') return finish(before);
    if (!mods.length && (e.code === 'Backspace' || e.code === 'Delete')) return finish('');

    const key = keyFromCode(e.code);
    if (!key) { // only modifiers so far: show them while the user holds them
      el.value = mods.length ? prettyAccel(mods.join('+')) + ' + ...' : 'Nhấn tổ hợp phím...';
      el.classList.toggle('partial', mods.length > 0);
      return;
    }
    const standalone = /^F\d+$/.test(key) || key === 'PrintScreen';
    if (!mods.length && !standalone) {
      setStatus('Cần kèm Ctrl / Alt / Shift / Win (trừ F1–F24, PrintScreen)', false, 2500);
      return;
    }
    const accel = [...mods, key].join('+');
    const clash = HOTKEY_IDS.find((other) => other !== id && getHotkeyValue(other) === accel);
    if (clash) {
      setStatus(`Trùng phím với "${$(`hk-${clash}`).closest('.hk-row').previousElementSibling.textContent}"`, false, 2500);
      return;
    }
    el.classList.remove('partial');
    finish(accel);
  };
  el.addEventListener('keydown', handle);
  // Windows only sends keyup for PrintScreen
  el.addEventListener('keyup', (e) => { if (e.code === 'PrintScreen') handle(e); });
});

document.querySelectorAll('[data-reset]').forEach((btn) => {
  btn.addEventListener('click', () => setHotkeyValue(btn.dataset.reset, hotkeyDefaults[btn.dataset.reset] || ''));
});

// ---------------------------------------------------------------- update
const updStatus = $('updStatus');
const btnUpdate = $('btnUpdate');
let updState = null;

function renderUpdate(u) {
  updState = u;
  $('updVersion').textContent = `v${u.current}`;
  $('autoUpdateToggle').checked = !!u.autoCheck;
  const bar = $('updBar');
  bar.style.display = u.status === 'downloading' ? 'block' : 'none';
  $('updBarFill').style.width = `${u.percent || 0}%`;
  updStatus.className = 'upd-status';
  btnUpdate.disabled = false;
  switch (u.status) {
    case 'checking':
      updStatus.textContent = 'Đang kiểm tra...'; btnUpdate.disabled = true; btnUpdate.textContent = 'Kiểm tra cập nhật'; break;
    case 'latest':
      updStatus.textContent = 'Đang dùng bản mới nhất'; updStatus.classList.add('good'); btnUpdate.textContent = 'Kiểm tra cập nhật'; break;
    case 'downloading':
      updStatus.textContent = `Đang tải bản ${u.version}... ${u.percent || 0}%`; btnUpdate.disabled = true; btnUpdate.textContent = 'Đang tải'; break;
    case 'ready':
      updStatus.textContent = `Bản ${u.version} đã sẵn sàng`; updStatus.classList.add('good'); btnUpdate.textContent = 'Khởi động lại để cập nhật'; break;
    case 'available':
      updStatus.textContent = `Có bản mới ${u.version}${u.selfUpdate ? '' : ' (bản này không tự cập nhật được)'}`; btnUpdate.textContent = 'Mở trang tải về'; break;
    case 'error':
      updStatus.textContent = u.error || 'Lỗi kiểm tra cập nhật'; updStatus.classList.add('err'); btnUpdate.textContent = 'Thử lại'; break;
    default:
      updStatus.textContent = u.selfUpdate ? '' : 'Bản này chỉ báo khi có bản mới'; btnUpdate.textContent = 'Kiểm tra cập nhật';
  }
}

btnUpdate.addEventListener('click', async () => {
  if (updState?.status === 'ready') return ipcRenderer.invoke('update-install');
  if (updState?.status === 'available') return ipcRenderer.invoke('update-open-releases');
  renderUpdate(await ipcRenderer.invoke('update-check'));
});
$('autoUpdateToggle').addEventListener('change', (e) => ipcRenderer.invoke('update-set-auto', e.target.checked));
ipcRenderer.on('update-status', (_e, u) => renderUpdate(u));
ipcRenderer.invoke('update-get-state').then(renderUpdate).catch(() => {});

btnApply.addEventListener('click', handleApply);
btnDefault.addEventListener('click', setDefaultsOnlyInUI);
btnClose.addEventListener('click', () => ipcRenderer.send('close-main'));

loadInitial();