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
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
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
        running = true
        return START_NOT_STICKY
    }

    // ---------------------------------------------------------------- notification

    private fun startInForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Bong bóng OCR", NotificationManager.IMPORTANCE_LOW)
        )
        val stopPi = PendingIntent.getService(
            this, 0, Intent(this, BubbleService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val openPi = PendingIntent.getActivity(
            this, 1, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val notif = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("Snap Assistant đang chạy")
            .setContentText("Chạm bong bóng để OCR & dịch")
            .setContentIntent(openPi)
            .addAction(Notification.Action.Builder(null, "Tắt", stopPi).build())
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIF_ID, notif)
        }
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
        view.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY; startX = lp.x; startY = lp.y; moved = false
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downX; val dy = e.rawY - downY
                    if (moved || abs(dx) > slop || abs(dy) > slop) {
                        moved = true
                        lp.x = startX + dx.toInt()
                        lp.y = startY + dy.toInt()
                        wm.updateViewLayout(view, lp)
                    }
                }
                MotionEvent.ACTION_UP -> {
                    if (!moved) onBubbleTapped() else snapToEdge(view, lp)
                }
            }
            true
        }
        wm.addView(view, lp)
        bubble = view
        bubbleParams = lp
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
        val view = SelectionView(
            this, shot,
            onSelected = { rect -> finishSelection(shot, rect) },
            onCancel = { finishSelection(shot, null) },
        )
        wm.addView(view, fullScreenParams(focusable = false))
        selectionView = view
    }

    private fun finishSelection(shot: Bitmap, rect: Rect?) {
        selectionView?.let { runCatching { wm.removeView(it) } }
        selectionView = null
        bubble?.visibility = View.VISIBLE
        busy = false
        if (rect == null) {
            shot.recycle()
            return
        }
        val crop = Bitmap.createBitmap(shot, rect.left, rect.top, rect.width(), rect.height())
        if (crop !== shot) shot.recycle()
        runOcrAndTranslate(crop)
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

    private inner class ResultPanel(val root: View, val ocr: TextView, val tr: TextView) {
        fun setOcr(s: String) { ocr.text = s }
        fun setTranslation(s: String) { tr.text = s }
    }

    private fun showResult(): ResultPanel {
        removeResult()
        val pad = dp(14)
        val (_, sh, _) = screenMetrics()

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
        val scroll = object : ScrollView(this) {
            override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
                val max = (sh * 0.5f).toInt()
                super.onMeasure(widthMeasureSpec, MeasureSpec.makeMeasureSpec(max, MeasureSpec.AT_MOST))
            }
        }.apply { addView(content) }

        fun btn(s: String, onClick: () -> Unit) = Button(this).apply {
            text = s
            isAllCaps = false
            setOnClickListener { onClick() }
        }
        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
            addView(btn("Copy bản dịch") { copy(tr.text) })
            addView(btn("Copy gốc") { copy(ocr.text) })
            addView(btn("Đóng") { removeResult() })
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
            gravity = Gravity.BOTTOM
            y = dp(24)
            horizontalMargin = 0.03f
        }
        wm.addView(root, lp)
        resultView = root
        return ResultPanel(root, ocr, tr)
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
