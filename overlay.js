const { ipcRenderer } = require('electron');
const winlog = (msg, data) => ipcRenderer.send('log', { level: 'INFO', msg: `overlay: ${msg}`, data });


let img = new Image();
let canvas, ctx;
let startX, startY, endX, endY, isDrawing = false;

window.onload = () => {
  canvas = document.getElementById('canvas');
  ctx = canvas.getContext('2d');
  window.focus();

  ipcRenderer.on('set-image', (event, dataUrl) => {
    img.src = dataUrl;
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
    };
  });

  canvas.addEventListener('mousedown', (e) => {
    isDrawing = true;
    startX = e.offsetX;
    startY = e.offsetY;
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!isDrawing) return;
    endX = e.offsetX;
    endY = e.offsetY;
    redraw();
  });

  canvas.addEventListener('mouseup', () => {
    isDrawing = false;
    const x = Math.min(startX, endX);
    const y = Math.min(startY, endY);
    const w = Math.abs(startX - endX);
    const h = Math.abs(startY - endY);

    if (w > 5 && h > 5) {
      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = w;
      cropCanvas.height = h;
      cropCanvas.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);

      ipcRenderer.invoke('region-selected', cropCanvas.toDataURL());
    } else {
      ipcRenderer.invoke('cancel-overlay');
    }
  });
};

function redraw() {
  ctx.drawImage(img, 0, 0);
  if (isDrawing) {
    ctx.strokeStyle = 'red';
    ctx.lineWidth = 2;
    ctx.strokeRect(startX, startY, endX - startX, endY - startY);
  }
}
