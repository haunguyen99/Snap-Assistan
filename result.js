const { ipcRenderer } = require('electron');

// Nhận tiến trình OCR
ipcRenderer.on('ocr-progress', (event, msg) => {
  const progressEl = document.getElementById('progress');
  if (msg.status === 'recognizing text') {
    progressEl.innerText = `🔍 Đang OCR... ${Math.round(msg.progress * 100)}%`;
  } else {
    progressEl.innerText = `⏳ ${msg.status}`;
  }
});

// Nhận kết quả cuối cùng
ipcRenderer.on('screenshot-result', (event, data) => {
  document.getElementById('ocr').innerText = data.ocr || '❌ Không có kết quả OCR';
  document.getElementById('translation').innerText = data.translation || '❌ Không có kết quả dịch';
  document.getElementById('progress').innerText = "✅ OCR hoàn tất";
});
