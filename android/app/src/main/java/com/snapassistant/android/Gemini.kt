package com.snapassistant.android

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/** Gọi Gemini REST API để dịch, giống bản desktop (main.js). */
object Gemini {

    suspend fun translate(text: String, prefs: Prefs): String = withContext(Dispatchers.IO) {
        val key = prefs.apiKey
        if (key.isBlank()) return@withContext "❌ Chưa có API key. Mở app Snap Assistant để nhập."

        val prompt = "Dịch đoạn văn bản sau sang ${prefs.targetLang}. " +
            "Chỉ trả về bản dịch, giữ nguyên xuống dòng, không giải thích thêm:\n\n$text"
        val body = JSONObject().put(
            "contents", JSONArray().put(
                JSONObject().put("role", "user").put(
                    "parts", JSONArray().put(JSONObject().put("text", prompt))
                )
            )
        )

        val model = URLEncoder.encode(prefs.model, "UTF-8")
        val url = URL("https://generativelanguage.googleapis.com/v1beta/models/$model:generateContent")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 60_000
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("x-goog-api-key", key)
        }
        try {
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val raw = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            val json = runCatching { JSONObject(raw) }.getOrNull()
                ?: return@withContext "❌ Phản hồi không hợp lệ (HTTP $code)"

            json.optJSONObject("error")?.let { err ->
                return@withContext if (err.optInt("code") == 429)
                    "⚠️ Gemini báo hết quota hoặc giới hạn. Thử lại sau 1 phút hoặc dùng API key khác."
                else "❌ Lỗi API: ${err.optString("message")}"
            }

            val parts = json.optJSONArray("candidates")?.optJSONObject(0)
                ?.optJSONObject("content")?.optJSONArray("parts")
                ?: return@withContext "❌ Không có kết quả"
            buildString {
                for (i in 0 until parts.length()) append(parts.optJSONObject(i)?.optString("text").orEmpty())
            }.trim().ifEmpty { "❌ Không có kết quả" }
        } catch (e: Exception) {
            "❌ Lỗi khi gọi tới Gemini (kiểm tra mạng hoặc API key): ${e.message}"
        } finally {
            conn.disconnect()
        }
    }
}
