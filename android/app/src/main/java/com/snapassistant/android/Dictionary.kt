package com.snapassistant.android

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/** Pronunciation of one English word: IPA and recorded audio (US / UK) when available. */
data class Pron(
    val usIpa: String? = null,
    val ukIpa: String? = null,
    val ipa: String? = null,
    val usAudio: String? = null,
    val ukAudio: String? = null,
)

/** Free dictionary API (dictionaryapi.dev): no key, no Gemini quota. */
object Dictionary {

    sealed class Result {
        data class Found(val pron: Pron) : Result()
        object NotFound : Result()
        data class Error(val message: String) : Result()
    }

    private val cache = HashMap<String, Result>()

    /** English words in reading order, de-duplicated (case-insensitive), at most [limit]. */
    fun extractWords(text: String, limit: Int = 40): List<String> {
        val seen = LinkedHashMap<String, String>()
        Regex("[A-Za-z]+(?:'[A-Za-z]+)?").findAll(text).forEach { m ->
            val w = m.value
            val key = w.lowercase()
            if (w.length >= 2 || key == "a" || key == "i") seen.putIfAbsent(key, w)
        }
        return seen.values.take(limit)
    }

    suspend fun lookup(word: String): Result {
        val key = word.lowercase()
        synchronized(cache) { cache[key] }?.let { return it }
        val result = withContext(Dispatchers.IO) { fetch(key) }
        if (result !is Result.Error) synchronized(cache) { cache[key] = result }
        return result
    }

    private fun fetch(word: String): Result {
        val url = URL("https://api.dictionaryapi.dev/api/v2/entries/en/" + URLEncoder.encode(word, "UTF-8"))
        val conn = (url.openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 15_000
        }
        return try {
            val code = conn.responseCode
            if (code == 404) return Result.NotFound
            if (code !in 200..299) return Result.Error("HTTP $code")
            val raw = conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            parse(JSONArray(raw))
        } catch (e: Exception) {
            Result.Error(e.message ?: "lỗi mạng")
        } finally {
            conn.disconnect()
        }
    }

    private fun parse(entries: JSONArray): Result {
        var us: String? = null; var uk: String? = null; var any: String? = null
        var usAudio: String? = null; var ukAudio: String? = null
        for (i in 0 until entries.length()) {
            val e = entries.optJSONObject(i) ?: continue
            e.optString("phonetic").takeIf { it.isNotBlank() }?.let { if (any == null) any = it }
            val ph = e.optJSONArray("phonetics") ?: continue
            for (j in 0 until ph.length()) {
                val p = ph.optJSONObject(j) ?: continue
                val text = p.optString("text").takeIf { it.isNotBlank() }
                val audio = p.optString("audio").takeIf { it.isNotBlank() }
                when {
                    audio != null && audio.endsWith("-us.mp3") -> {
                        if (usAudio == null) usAudio = audio
                        if (us == null && text != null) us = text
                    }
                    audio != null && audio.endsWith("-uk.mp3") -> {
                        if (ukAudio == null) ukAudio = audio
                        if (uk == null && text != null) uk = text
                    }
                }
                if (any == null && text != null) any = text
            }
        }
        if (us == null && uk == null && any == null && usAudio == null && ukAudio == null) return Result.NotFound
        return Result.Found(Pron(us, uk, any, usAudio, ukAudio))
    }
}
