const { ipcRenderer } = require('electron');
const winlog = (msg, data) => ipcRenderer.send('log', { level: 'INFO', msg: `renderer: ${msg}`, data });


// === API Key ===
document.getElementById('saveKeyBtn').addEventListener('click', async () => {
  const key = document.getElementById('apiKeyInput').value;
  const ok = await ipcRenderer.invoke('save-api-key', key);
  alert(ok ? "✅ Key đã lưu" : "❌ Key đã xóa");
});

(async () => {
  const savedKey = await ipcRenderer.invoke('get-api-key');
  document.getElementById('apiKeyInput').value = savedKey;
})();

// === Hotkey ===
document.getElementById('saveHotkeyBtn').addEventListener('click', async () => {
  const hotkey = document.getElementById('hotkeyInput').value;
  const ok = await ipcRenderer.invoke('save-hotkey', hotkey);
  alert(ok ? `✅ Hotkey đã lưu: ${hotkey}` : "❌ Hotkey không hợp lệ");
});

(async () => {
  const savedHotkey = await ipcRenderer.invoke('get-hotkey');
  document.getElementById('hotkeyInput').value = savedHotkey || 'CommandOrControl+Shift+S';
})();
