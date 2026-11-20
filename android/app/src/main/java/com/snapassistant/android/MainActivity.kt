package com.snapassistant.android

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

@Suppress("DEPRECATION")
class MainActivity : Activity() {

    private lateinit var prefs: Prefs
    private lateinit var keyInput: EditText
    private lateinit var langInput: EditText
    private lateinit var modelInput: EditText
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)

        val pad = dp(20)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad + dp(24), pad, pad)
        }

        root.addView(TextView(this).apply {
            text = "Snap Assistant"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 26f)
            setTextColor(Color.parseColor("#1E293B"))
        })
        root.addView(TextView(this).apply {
            text = "Bong bóng nổi → chạm để chụp màn hình → kéo chọn vùng → OCR (ML Kit, offline) → dịch bằng Gemini."
            setPadding(0, dp(6), 0, dp(16))
            setTextColor(Color.parseColor("#475569"))
        })

        keyInput = field(root, "Gemini API key", prefs.apiKey).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        langInput = field(root, "Dịch sang ngôn ngữ", prefs.targetLang)
        modelInput = field(root, "Model Gemini", prefs.model)

        root.addView(button("Lưu cài đặt") {
            prefs.apiKey = keyInput.text.toString()
            prefs.targetLang = langInput.text.toString()
            prefs.model = modelInput.text.toString()
            toast("Đã lưu")
        })
        root.addView(button("Bật bong bóng nổi") { startBubbleFlow() })
        root.addView(button("Tắt bong bóng") {
            stopService(Intent(this, BubbleService::class.java))
            refreshStatus()
        })

        status = TextView(this).apply { setPadding(0, dp(16), 0, 0) }
        root.addView(status)

        setContentView(ScrollView(this).apply {
            setBackgroundColor(Color.parseColor("#F8FAFC"))
            addView(root)
        })
    }

    override fun onResume() {
        super.onResume()
        refreshStatus()
    }

    private fun refreshStatus() {
        val overlay = Settings.canDrawOverlays(this)
        status.text = buildString {
            append("Quyền hiển thị trên app khác: ").append(if (overlay) "✅" else "❌").append('\n')
            append("Bong bóng: ").append(if (BubbleService.running) "đang chạy" else "tắt")
        }
    }

    private fun startBubbleFlow() {
        prefs.apiKey = keyInput.text.toString()
        prefs.targetLang = langInput.text.toString()
        prefs.model = modelInput.text.toString()

        if (!Settings.canDrawOverlays(this)) {
            toast("Hãy cho phép \"Hiển thị trên ứng dụng khác\" rồi bấm lại")
            startActivity(
                Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))
            )
            return
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
            return
        }
        requestProjection()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        // Thông báo không bắt buộc; dù từ chối vẫn tiếp tục.
        if (requestCode == REQ_NOTIFY) requestProjection()
    }

    private fun requestProjection() {
        val mpm = getSystemService(MediaProjectionManager::class.java)
        startActivityForResult(mpm.createScreenCaptureIntent(), REQ_PROJECTION)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_PROJECTION) return
        if (resultCode != RESULT_OK || data == null) {
            toast("Cần quyền ghi màn hình để chụp")
            return
        }
        val svc = Intent(this, BubbleService::class.java)
            .putExtra(BubbleService.EXTRA_RESULT_CODE, resultCode)
            .putExtra(BubbleService.EXTRA_DATA, data)
        startForegroundService(svc)
        toast("Đã bật bong bóng")
        moveTaskToBack(true)
    }

    private fun field(parent: LinearLayout, label: String, value: String): EditText {
        parent.addView(TextView(this).apply {
            text = label
            setTextColor(Color.parseColor("#334155"))
            setPadding(0, dp(8), 0, dp(2))
        })
        return EditText(this).apply {
            setText(value)
            isSingleLine = true
            parent.addView(this)
        }
    }

    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        gravity = Gravity.CENTER
        setOnClickListener { onClick() }
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    companion object {
        private const val REQ_PROJECTION = 1001
        private const val REQ_NOTIFY = 1002
    }
}
