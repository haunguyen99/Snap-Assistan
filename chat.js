const { ipcRenderer } = require("electron");

const elMessages = document.getElementById("messages");
const elInput = document.getElementById("chatInput");
const btnSend = document.getElementById("btnSend");
const elStatus = document.getElementById("status");

// Lưu lịch sử chat
let chatHistory = [];

/* ============================================================
   ✨ Hiển thị tin nhắn với định dạng Markdown cơ bản
   ============================================================ */
function appendMessage(role, text) {
  const div = document.createElement("div");
  div.className = role === "user" ? "user-msg" : "ai-msg";

  // Avatar
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "👤" : "🤖";

  // Nội dung tin nhắn
  const content = document.createElement("div");
  content.className = "message-content";

  // Escape HTML trước khi áp dụng Markdown
  const safeText = String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Thay thế markdown cơ bản
  let formatted = safeText
    .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")      // **bold**
    .replace(/\*(.*?)\*/g, "<i>$1</i>")          // *italic*
    .replace(/`([^`]+)`/g, "<code>$1</code>")    // `inline code`
    .replace(/\n/g, "<br>");                     // xuống dòng

  // Xử lý code block ``` ```
  formatted = formatted.replace(/```([\s\S]*?)```/g, (m, p1) => {
    return `<pre><code>${p1}</code></pre>`;
  });

  content.innerHTML = formatted;

  // Thời gian
  const time = document.createElement("div");
  time.className = "message-time";
  time.textContent = new Date().toLocaleTimeString("vi-VN");

  div.appendChild(avatar);
  div.appendChild(content);
  div.appendChild(time);

  elMessages.appendChild(div);
  elMessages.scrollTop = elMessages.scrollHeight;
}

/* ============================================================
   Quản lý trạng thái UI
   ============================================================ */
function setStatus(text, type = "info") {
  elStatus.textContent = text;
  elStatus.className = type;
}

// ✅ Sửa: ép blur + focus lại để Electron nhận phím sau khi bật lại
function setChatControlsEnabled(enabled) {
  elInput.disabled = !enabled;
  btnSend.disabled = !enabled;

  if (enabled) {
    elInput.blur();
    setTimeout(() => {
      elInput.focus();
    }, 0);
  }
}

/* ============================================================
   Tải và hiển thị lịch sử chat
   ============================================================ */
async function loadHistory() {
  try {
    const history = await ipcRenderer.invoke("chat-get-history");
    elMessages.innerHTML = "";
    chatHistory = history || [];

    chatHistory.forEach((msg) => {
      appendMessage(msg.role, msg.text);
    });

    if (chatHistory.length === 0) {
      setStatus("💬 Bắt đầu cuộc trò chuyện mới", "info");
    } else {
      setStatus(`📝 Đã tải ${chatHistory.length} tin nhắn`, "success");
    }
  } catch (err) {
    console.error("Lỗi tải lịch sử:", err);
    setStatus("⚠️ Không thể tải lịch sử chat", "error");
  }
}

/* ============================================================
   Gửi tin nhắn
   ============================================================ */
async function sendMessage() {
  const text = elInput.value.trim();
  if (!text) {
    setStatus("⚠️ Vui lòng nhập tin nhắn", "warning");
    return;
  }

  appendMessage("user", text);
  chatHistory.push({ role: "user", text });

  elInput.value = "";
  setChatControlsEnabled(false);
  setStatus("⏳ Đang gửi tin nhắn...", "loading");

  try {
    const result = await ipcRenderer.invoke("chat-ask", text);

    if (result.ok) {
      appendMessage("assistant", result.text);
      chatHistory.push({ role: "assistant", text: result.text });
      setStatus("✅ Đã nhận phản hồi", "success");

      setTimeout(() => setStatus("💬 Tiếp tục trò chuyện...", "info"), 2000);
    } else {
      const errorMsg = result.error || result.text || "Lỗi không xác định";
      appendMessage("assistant", `❌ ${errorMsg}`);
      setStatus("❌ Lỗi phản hồi", "error");
    }
  } catch (err) {
    console.error("Lỗi gửi tin nhắn:", err);
    appendMessage("assistant", "❌ Lỗi khi gửi tin nhắn. Vui lòng thử lại.");
    setStatus("❌ Lỗi kết nối", "error");
  } finally {
    setChatControlsEnabled(true);
  }
}



btnSend.addEventListener("click", sendMessage);
elInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

elInput.addEventListener("blur", () => {
  if (document.hasFocus()) {
    setTimeout(() => elInput.focus(), 100);
  }
});

/* ============================================================
   Khởi tạo
   ============================================================ */
loadHistory();
setChatControlsEnabled(true);
