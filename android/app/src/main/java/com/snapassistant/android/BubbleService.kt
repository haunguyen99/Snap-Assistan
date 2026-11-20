package com.snapassistant.android

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.AudioAttributes
import android.media.Image
import android.media.ImageReader
import android.media.MediaPlayer
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.util.DisplayMetrics
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import java.util.Locale
import kotlin.math.abs

/**
 * Foreground service giữ MediaProjection, hiện bong bóng nổi.
 * Chạm bong bóng → chụp màn hình → chọn vùng → OCR (ML Kit) → dịch (Gemini).
 */
class BubbleService : Service() {

    private lateinit var wm: WindowManager
    private lateinit var prefs: Prefs
    private val main = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }

    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private val imageThread = HandlerThread("snap-capture").apply { start() }
    private val imageHandler = Handler(imageThread.looper)
    private val imageLock = Any()
    private var latestImage: Image? = null

    private var bubble: View? = null
    private var bubbleParams: WindowManager.LayoutParams? = null
    private var selectionView: View? = null
    private var resultView: View? = null
    private var busy = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        wm = getSystemService(WindowManager::class.java)
        prefs = Prefs(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (projection != null) return START_NOT_STICKY

        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
        @Suppress("DEPRECATION")
        val data: Intent? = intent?.getParcelableExtra(EXTRA_DATA)
        if (data == null) {
            stopSelf()
            return START_NOT_STICKY
        }

        startInForeground()

        val mpm = getSystemService(MediaProjectionManager::class.java)
        val mp = mpm.getMediaProjection(resultCode, data)
        if (mp == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        mp.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                main.post { stopSelf() }
            }
        }, main)
        projection = mp
        setupCapture()
        showBubble()
        ensureTts()
        running = true
        return START_NOT_STICKY
    }

    // ---------------------------------------------------------------- notification

    private fun startInForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Bong bóng OCR", NotificationManager.IMPORTANCE_LOW)
        )
        val notif = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun buildNotification(): Notification {
        val stopPi = PendingIntent.getService(
            this, 0, Intent(this, BubbleService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val openPi = PendingIntent.getActivity(
            this, 1, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("Snap Assistant · Chế độ: ${modeLabel()}")
            .setContentText("Chạm bong bóng để chọn vùng chữ · Nhấn giữ để đổi chế độ")
            .setContentIntent(openPi)
            .addAction(Notification.Action.Builder(null, "Tắt", stopPi).build())
            .setOngoing(true)
            .build()
    }

    // ---------------------------------------------------------------- capture

    private fun screenMetrics(): Triple<Int, Int, Int> {
        val dpi = resources.displayMetrics.densityDpi
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val b = wm.currentWindowMetrics.bounds
            Triple(b.width(), b.height(), dpi)
        } else {
            val dm = DisplayMetrics()
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getRealMetrics(dm)
            Triple(dm.widthPixels, dm.heightPixels, dpi)
        }
    }

    @SuppressLint("WrongConstant")
    private fun newReader(w: Int, h: Int): ImageReader =
        ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 3).apply {
            setOnImageAvailableListener({ r ->
                val img = runCatching { r.acquireLatestImage() }.getOrNull() ?: return@setOnImageAvailableListener
                synchronized(imageLock) {
                    if (r !== reader) { img.close(); return@setOnImageAvailableListener }
                    latestImage?.close()
                    latestImage = img
                }
            }, imageHandler)
        }

    private fun setupCapture() {
        val (w, h, dpi) = screenMetrics()
        val r = newReader(w, h)
        synchronized(imageLock) { reader = r }
        virtualDisplay = projection?.createVirtualDisplay(
            "snap-assistant", w, h, dpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, null,
        )
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        val vd = virtualDisplay ?: return
        val (w, h, dpi) = screenMetrics()
        val old = reader
        if (old != null && old.width == w && old.height == h) return
        val r = newReader(w, h)
        synchronized(imageLock) {
            reader = r
            latestImage?.close()
            latestImage = null
        }
        vd.resize(w, h, dpi)
        vd.surface = r.surface
        imageHandler.post { old?.close() }
    }

    private fun grabScreen(): Bitmap? = synchronized(imageLock) {
        val img = latestImage ?: return null
        val plane = img.planes[0]
        val pixelStride = plane.pixelStride
        val rowPadding = plane.rowStride - pixelStride * img.width
        val tmp = Bitmap.createBitmap(img.width + rowPadding / pixelStride, img.height, Bitmap.Config.ARGB_8888)
        plane.buffer.rewind()
        tmp.copyPixelsFromBuffer(plane.buffer)
        if (tmp.width == img.width) tmp
        else Bitmap.createBitmap(tmp, 0, 0, img.width, img.height).also { tmp.recycle() }
    }

    private fun onBubbleTapped() {
        if (busy) return
        busy = true
        removeResult()
        bubble?.visibility = View.INVISIBLE
        // Chờ một khung hình mới (không có bong bóng) rồi mới lấy ảnh.
        main.postDelayed({
            val shot = grabScreen()
            if (shot == null) {
                toast("Chưa lấy được ảnh màn hình, thử lại")
                bubble?.visibility = View.VISIBLE
                busy = false
                return@postDelayed
            }
            showSelection(shot)
        }, 350)
    }

    // ---------------------------------------------------------------- windows

    private fun overlayType() = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY

    @SuppressLint("ClickableViewAccessibility")
    private fun showBubble() {
        val size = dp(56)
        val view = ImageView(this).apply {
            setImageResource(R.drawable.ic_notify)
            setBackgroundResource(R.drawable.bubble_bg)
            val p = dp(14)
            setPadding(p, p, p, p)
            elevation = dp(6).toFloat()
            contentDescription = "OCR & dịch"
        }
        val (sw, sh, _) = screenMetrics()
        val lp = WindowManager.LayoutParams(
            size, size, overlayType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = sw - size - dp(8)
            y = sh / 3
        }

        val slop = ViewConfiguration.get(this).scaledTouchSlop
        var downX = 0f; var downY = 0f; var startX = 0; var startY = 0; var moved = false
        var longPressed = false
        // Long-press switches between pronunciation and translation mode.
        val longPress = Runnable {
            if (!moved) {
                longPressed = true
                view.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
                toggleMode()
            }
        }
        view.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY; startX = lp.x; startY = lp.y; moved = false
                    longPressed = false
                    main.postDelayed(longPress, ViewConfiguration.getLongPressTimeout().toLong())
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downX; val dy = e.rawY - downY
                    if (moved || abs(dx) > slop || abs(dy) > slop) {
                        moved = true
                        main.removeCallbacks(longPress)
                        lp.x = startX + dx.toInt()
                        lp.y = startY + dy.toInt()
                        wm.updateViewLayout(view, lp)
                    }
                }
                MotionEvent.ACTION_UP -> {
                    main.removeCallbacks(longPress)
                    if (moved) snapToEdge(view, lp) else if (!longPressed) onBubbleTapped()
                }
                MotionEvent.ACTION_CANCEL -> main.removeCallbacks(longPress)
            }
            true
        }
        wm.addView(view, lp)
        bubble = view
        bubbleParams = lp
    }

    private fun modeLabel() = if (prefs.mode == Prefs.MODE_TRANSLATE) "Dịch" else "Phát âm"

    private fun toggleMode() {
        prefs.mode = if (prefs.mode == Prefs.MODE_TRANSLATE) Prefs.MODE_PRONOUNCE else Prefs.MODE_TRANSLATE
        toast("Chế độ: ${modeLabel()}")
        getSystemService(NotificationManager::class.java).notify(NOTIF_ID, buildNotification())
    }

    private fun snapToEdge(view: View, lp: WindowManager.LayoutParams) {
        val (sw, sh, _) = screenMetrics()
        lp.x = if (lp.x + lp.width / 2 < sw / 2) dp(4) else sw - lp.width - dp(4)
        lp.y = lp.y.coerceIn(0, sh - lp.height)
        wm.updateViewLayout(view, lp)
    }

    private fun fullScreenParams(focusable: Boolean) = WindowManager.LayoutParams(
        WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, overlayType(),
        (if (focusable) 0 else WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE) or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT,
    ).apply {
        gravity = Gravity.TOP or Gravity.START
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
    }

    private fun showSelection(shot: Bitmap) {
        val tapToPick = prefs.mode != Prefs.MODE_TRANSLATE
        // Pronunciation mode: OCR the whole screen right away so a word can be tapped directly.
        var words: List<Pair<Rect, String>>? = null
        var pendingTap: Pair<Float, Float>? = null
        lateinit var view: SelectionView

        fun pick(x: Float, y: Float) {
            val list = words ?: run { pendingTap = x to y; return }
            val hit = wordAt(list, x, y)
            if (hit == null) {
                toast("Không thấy từ ở chỗ này")
                return
            }
            val word = Dictionary.extractWords(hit.second).firstOrNull()
            if (word == null) {
                toast("\"${hit.second}\" không phải từ tiếng Anh")
                return
            }
            // Stay on the overlay so more words can be tapped; the card goes on the side
            // of the screen away from the word so it does not cover it.
            view.highlight(hit.first)
            // Speak at once with the phone's voice; the dictionary (IPA, recordings) loads after.
            speak(word, Locale.US)
            val wordInLowerHalf = hit.first.centerY() > shot.height / 2
            pronounce(singleWord = true, atTop = wordInLowerHalf) { word }
        }

        view = SelectionView(
            this, shot, tapToPick,
            onSelected = { rect -> finishSelection(shot, rect) },
            onTap = { x, y -> pick(x, y) },
            onCancel = { finishSelection(shot, null) },
        )
        wm.addView(view, fullScreenParams(focusable = false))
        selectionView = view

        if (tapToPick) {
            scope.launch {
                val found = runCatching { recognizeWords(shot) }.getOrElse { emptyList() }
                if (selectionView !== view) return@launch
                words = found
                view.setWordBoxes(found.map { it.first })
                pendingTap?.let { (x, y) -> pendingTap = null; pick(x, y) }
            }
        }
    }

    /** The word box under (x, y), or the nearest one within a finger's width. */
    private fun wordAt(list: List<Pair<Rect, String>>, x: Float, y: Float): Pair<Rect, String>? {
        val reach = dp(24).toFloat()
        var best: Pair<Rect, String>? = null
        var bestD = Float.MAX_VALUE
        for (w in list) {
            val r = w.first
            val dx = maxOf(r.left - x, 0f, x - r.right)
            val dy = maxOf(r.top - y, 0f, y - r.bottom)
            val d = dx * dx + dy * dy
            if (d < bestD) { bestD = d; best = w }
        }
        return best?.takeIf { bestD <= reach * reach }
    }

    /** Close everything: the word-picking overlay and any card on top of it. */
    private fun closeAll() {
        removeResult()
        stopAudio()
        if (selectionView != null) {
            selectionView?.let { runCatching { wm.removeViewImmediate(it) } }
            selectionView = null
            bubble?.visibility = View.VISIBLE
            busy = false
        }
    }

    private fun finishSelection(shot: Bitmap, rect: Rect?) {
        if (rect == null) { closeAll(); return }
        // Remove synchronously so the view never draws `shot` again. `shot` is left to the GC:
        // recycling it here crashed the app ("trying to use a recycled bitmap").
        selectionView?.let { runCatching { wm.removeViewImmediate(it) } }
        selectionView = null
        bubble?.visibility = View.VISIBLE
        busy = false
        val crop = Bitmap.createBitmap(shot, rect.left, rect.top, rect.width(), rect.height())
        if (prefs.mode == Prefs.MODE_TRANSLATE) runOcrAndTranslate(crop) else runOcrAndPronounce(crop)
    }

    private fun runOcrAndTranslate(crop: Bitmap) {
        val panel = showResult()
        scope.launch {
            val text = try {
                recognize(crop)
            } catch (e: Exception) {
                panel.setOcr("❌ Lỗi OCR: ${e.message}")
                panel.setTranslation("")
                return@launch
            } finally {
                crop.recycle()
            }
            if (text.isBlank()) {
                panel.setOcr("(Không nhận dạng được chữ nào)")
                panel.setTranslation("")
                return@launch
            }
            panel.setOcr(text)
            panel.setTranslation("⏳ Đang dịch...")
            panel.setTranslation(Gemini.translate(text, prefs))
        }
    }

    /** Every OCR word on the bitmap with its box, in bitmap coordinates. */
    private suspend fun recognizeWords(src: Bitmap): List<Pair<Rect, String>> {
        val result = suspendCancellableCoroutine { cont ->
            recognizer.process(InputImage.fromBitmap(src, 0))
                .addOnSuccessListener { cont.resume(it) }
                .addOnFailureListener { cont.resumeWithException(it) }
        }
        return result.textBlocks.flatMap { b -> b.lines.flatMap { l -> l.elements } }
            .mapNotNull { el -> el.boundingBox?.let { it to el.text } }
    }

    private suspend fun recognize(src: Bitmap): String {
        // ML Kit nhận chữ tốt hơn khi chữ đủ lớn: phóng to vùng chọn nhỏ.
        val scale = if (src.width < 800 && src.height < 800) 2 else 1
        val bmp = if (scale > 1) Bitmap.createScaledBitmap(src, src.width * scale, src.height * scale, true) else src
        return try {
            suspendCancellableCoroutine { cont ->
                recognizer.process(InputImage.fromBitmap(bmp, 0))
                    .addOnSuccessListener { cont.resume(it.text) }
                    .addOnFailureListener { cont.resumeWithException(it) }
            }
        } finally {
            if (bmp !== src) bmp.recycle()
        }
    }

    // ---------------------------------------------------------------- result panel

    private inner class ResultPanel(val ocr: TextView, val tr: TextView) {
        fun setOcr(s: String) { ocr.text = s }
        fun setTranslation(s: String) { tr.text = s }
    }

    private fun showResult(): ResultPanel {
        removeResult()

        fun label(s: String) = TextView(this).apply {
            text = s
            setTextColor(Color.parseColor("#64748B"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setPadding(0, dp(8), 0, dp(2))
        }
        fun body(s: String) = TextView(this).apply {
            text = s
            setTextColor(Color.parseColor("#0F172A"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        }

        val ocr = body("⏳ Đang nhận dạng chữ...")
        val tr = body("")
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(label("BẢN DỊCH"))
            addView(tr)
            addView(label("VĂN BẢN GỐC (OCR)"))
            addView(ocr)
        }
        attachPanel(
            content,
            listOf("Copy bản dịch" to { copy(tr.text) }, "Copy gốc" to { copy(ocr.text) }),
        )
        return ResultPanel(ocr, tr)
    }

    private fun panelButton(s: String, onClick: () -> Unit) = Button(this).apply {
        text = s
        isAllCaps = false
        setOnClickListener { onClick() }
    }

    /** Bottom card overlay: scrollable [content] (max half screen) plus a row of buttons and "Đóng". */
    private fun attachPanel(content: View, actions: List<Pair<String, () -> Unit>>, atTop: Boolean = false) {
        val pad = dp(14)
        val (_, sh, _) = screenMetrics()
        val scroll = object : ScrollView(this) {
            override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
                val max = (sh * 0.5f).toInt()
                super.onMeasure(widthMeasureSpec, MeasureSpec.makeMeasureSpec(max, MeasureSpec.AT_MOST))
            }
        }.apply { addView(content) }

        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
            actions.forEach { (label, action) -> addView(panelButton(label, action)) }
            addView(panelButton("Đóng") { closeAll() })
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, pad / 2)
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(16).toFloat()
                setStroke(dp(1), Color.parseColor("#CBD5E1"))
            }
            elevation = dp(8).toFloat()
            addView(scroll)
            addView(buttons)
        }

        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT, overlayType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = if (atTop) Gravity.TOP else Gravity.BOTTOM
            y = if (atTop) dp(48) else dp(24)
            horizontalMargin = 0.03f
        }
        wm.addView(root, lp)
        resultView = root
    }

    // ---------------------------------------------------------------- pronunciation panel

    private fun runOcrAndPronounce(crop: Bitmap) = pronounce(singleWord = false) {
        try {
            recognize(crop)
        } finally {
            crop.recycle()
        }
    }

    /** Pronunciation panel for the English words in the text that [source] returns. */
    private fun pronounce(singleWord: Boolean, atTop: Boolean = false, source: suspend () -> String) {
        removeResult()
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val status = smallText("⏳ Đang nhận dạng chữ...")
        list.addView(status)
        var fullText = ""
        // A single tapped word needs no "read all" button.
        val actions = if (singleWord) emptyList() else listOf("🔊 Đọc cả đoạn" to { speak(fullText, Locale.US) })
        attachPanel(list, actions, atTop)

        scope.launch {
            val text = try {
                source()
            } catch (e: Exception) {
                status.text = "❌ Lỗi OCR: ${e.message}"
                return@launch
            }
            val words = Dictionary.extractWords(text)
            if (words.isEmpty()) {
                status.text = "(Không thấy từ tiếng Anh nào)"
                return@launch
            }
            fullText = text.replace(Regex("\\s+"), " ").trim()
            list.removeAllViews()
            words.forEach { word ->
                val ipa = smallText("…")
                val row = wordRow(word, ipa)
                list.addView(row.view)
                launch {
                    when (val r = Dictionary.lookup(word)) {
                        is Dictionary.Result.Found -> {
                            val p = r.pron
                            // Unlabelled IPA in this dictionary is usually the British form.
                            val uk = p.ukIpa ?: p.ipa?.takeIf { it != p.usIpa }
                            ipa.text = when {
                                p.usIpa != null && uk != null -> "US ${p.usIpa}   UK ${uk}"
                                else -> p.usIpa ?: uk ?: p.ipa ?: ""
                            }
                            row.usAudio = p.usAudio
                            row.ukAudio = p.ukAudio
                        }
                        Dictionary.Result.NotFound -> ipa.text = "(không có trong từ điển)"
                        is Dictionary.Result.Error -> ipa.text = "(không tra được: ${r.message})"
                    }
                    // A single tapped word is read out straight away.
                }
            }
        }
    }

    private inner class WordRow(val view: View) {
        var usAudio: String? = null
        var ukAudio: String? = null
    }

    private fun wordRow(word: String, ipa: TextView): WordRow {
        val texts = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(this@BubbleService).apply {
                text = word
                setTextColor(Color.parseColor("#0F172A"))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            })
            addView(ipa)
        }
        val line = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(6), 0, dp(6))
            addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        }
        val row = WordRow(line)
        line.addView(panelButton("🔊 US") { play(row.usAudio, word, Locale.US) })
        line.addView(panelButton("🔊 UK") { play(row.ukAudio, word, Locale.UK) })
        return row
    }

    private fun smallText(s: String) = TextView(this).apply {
        text = s
        setTextColor(Color.parseColor("#475569"))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
    }

    // ---------------------------------------------------------------- audio

    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var player: MediaPlayer? = null

    private fun ensureTts() {
        if (tts != null) return
        tts = TextToSpeech(this) { status -> ttsReady = status == TextToSpeech.SUCCESS }
    }

    /** Recorded dictionary audio when there is one, otherwise the phone's text-to-speech voice. */
    private fun play(audioUrl: String?, word: String, locale: Locale) {
        if (audioUrl == null) { speak(word, locale); return }
        stopAudio()
        player = MediaPlayer().apply {
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            setOnPreparedListener { it.start() }
            setOnCompletionListener { it.release(); if (player === it) player = null }
            setOnErrorListener { mp, _, _ ->
                mp.release(); if (player === mp) player = null
                speak(word, locale)
                true
            }
            try {
                setDataSource(audioUrl)
                prepareAsync()
            } catch (e: Exception) {
                release(); player = null
                speak(word, locale)
            }
        }
    }

    private fun speak(text: String, locale: Locale) {
        if (text.isBlank()) return
        ensureTts()
        val engine = tts ?: return
        if (!ttsReady) {
            toast("Giọng đọc đang khởi động, thử lại sau giây lát")
            return
        }
        stopAudio()
        val res = engine.setLanguage(locale)
        if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
            toast("Máy chưa có giọng tiếng Anh: cài trong Cài đặt → Chuyển văn bản thành giọng nói")
            return
        }
        engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "snap-tts")
    }

    private fun stopAudio() {
        player?.let { runCatching { it.stop() }; it.release() }
        player = null
        tts?.stop()
    }

    private fun removeResult() {
        resultView?.let { runCatching { wm.removeView(it) } }
        resultView = null
    }

    private fun copy(text: CharSequence) {
        if (text.isBlank()) return
        getSystemService(ClipboardManager::class.java)
            .setPrimaryClip(ClipData.newPlainText("Snap Assistant", text))
        toast("Đã copy")
    }

    // ---------------------------------------------------------------- teardown

    override fun onDestroy() {
        running = false
        scope.cancel()
        listOf(bubble, selectionView, resultView).forEach { v -> v?.let { runCatching { wm.removeView(it) } } }
        bubble = null; selectionView = null; resultView = null
        virtualDisplay?.release()
        virtualDisplay = null
        projection?.stop()
        projection = null
        synchronized(imageLock) {
            latestImage?.close()
            latestImage = null
        }
        reader?.close()
        reader = null
        imageThread.quitSafely()
        recognizer.close()
        stopAudio()
        tts?.shutdown()
        tts = null
        super.onDestroy()
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    companion object {
        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_DATA = "data"
        const val ACTION_STOP = "com.snapassistant.android.STOP"
        private const val CHANNEL_ID = "bubble"
        private const val NOTIF_ID = 1

        @Volatile
        var running = false
    }
}
