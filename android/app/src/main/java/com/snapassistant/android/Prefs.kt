package com.snapassistant.android

import android.content.Context

class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("snap_prefs", Context.MODE_PRIVATE)

    var apiKey: String
        get() = sp.getString("gemini_api_key", "") ?: ""
        set(v) = sp.edit().putString("gemini_api_key", v.trim()).apply()

    var targetLang: String
        get() = sp.getString("target_lang", "tiếng Việt") ?: "tiếng Việt"
        set(v) = sp.edit().putString("target_lang", v.trim().ifEmpty { "tiếng Việt" }).apply()

    var model: String
        get() = sp.getString("model", DEFAULT_MODEL) ?: DEFAULT_MODEL
        set(v) = sp.edit().putString("model", v.trim().ifEmpty { DEFAULT_MODEL }).apply()

    companion object {
        const val DEFAULT_MODEL = "gemini-2.5-flash"
    }
}
