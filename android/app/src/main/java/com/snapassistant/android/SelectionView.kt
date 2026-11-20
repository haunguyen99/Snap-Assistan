package com.snapassistant.android

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.view.MotionEvent
import android.view.View
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Hiện ảnh chụp màn hình toàn màn hình, cho kéo chọn vùng (giống overlay desktop).
 *
 * - [tapToPick] = false: chạm không kéo = huỷ.
 * - [tapToPick] = true: chạm vào một từ = [onTap] (toạ độ trong ảnh); nút ✕ để huỷ.
 *   Các từ OCR được (đưa vào qua [setWordBoxes]) được viền nhẹ để biết chạm vào đâu.
 */
@SuppressLint("ViewConstructor")
class SelectionView(
    context: Context,
    private val shot: Bitmap,
    private val tapToPick: Boolean,
    private val onSelected: (Rect) -> Unit,
    private val onTap: (Float, Float) -> Unit,
    private val onCancel: () -> Unit,
) : View(context) {

    private val density = resources.displayMetrics.density
    private val drawMatrix = Matrix()
    private val inverse = Matrix()
    private val imgBounds = RectF()

    private var startX = 0f
    private var startY = 0f
    private val sel = RectF()
    private var dragging = false
    private var finished = false

    /** Word boxes in bitmap coordinates; null while OCR is still running. */
    private var words: List<Rect>? = null
    private var picked: Rect? = null
    private var pressedClose = false

    private val dimPaint = Paint().apply { color = Color.argb(120, 0, 0, 0) }
    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#3B82F6")
        style = Paint.Style.STROKE
        strokeWidth = 2f * density
    }
    private val wordPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(150, 96, 165, 250)
        style = Paint.Style.STROKE
        strokeWidth = 1f * density
    }
    private val pickedPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(90, 250, 204, 21)
    }
    private val hintPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = 15f * density
        textAlign = Paint.Align.CENTER
        setShadowLayer(4f, 0f, 0f, Color.BLACK)
    }
    private val closeBg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(200, 15, 23, 42) }
    private val closeFg = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        strokeWidth = 2.5f * density
        strokeCap = Paint.Cap.ROUND
    }
    private val dimPath = Path()
    private val tmp = RectF()

    private val closeR get() = 22f * density
    private val closeCx get() = width - 40f * density
    private val closeCy get() = 64f * density

    fun setWordBoxes(boxes: List<Rect>) {
        words = boxes
        invalidate()
    }

    /** Briefly highlight the word that was picked (bitmap coordinates). */
    fun highlight(r: Rect) {
        picked = r
        invalidate()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        drawMatrix.setRectToRect(
            RectF(0f, 0f, shot.width.toFloat(), shot.height.toFloat()),
            RectF(0f, 0f, w.toFloat(), h.toFloat()),
            Matrix.ScaleToFit.CENTER,
        )
        drawMatrix.invert(inverse)
        imgBounds.set(0f, 0f, shot.width.toFloat(), shot.height.toFloat())
        drawMatrix.mapRect(imgBounds)
    }

    override fun onDraw(canvas: Canvas) {
        if (shot.isRecycled) return
        canvas.drawColor(Color.BLACK)
        canvas.drawBitmap(shot, drawMatrix, null)

        if (tapToPick && sel.isEmpty) {
            // Keep the screen readable; just outline the words that can be tapped.
            canvas.drawColor(Color.argb(40, 0, 0, 0))
            words?.forEach { r ->
                tmp.set(r); drawMatrix.mapRect(tmp)
                canvas.drawRoundRect(tmp, 3 * density, 3 * density, wordPaint)
            }
            picked?.let { r ->
                tmp.set(r); drawMatrix.mapRect(tmp)
                canvas.drawRoundRect(tmp, 3 * density, 3 * density, pickedPaint)
            }
        } else {
            dimPath.reset()
            dimPath.fillType = Path.FillType.EVEN_ODD
            dimPath.addRect(0f, 0f, width.toFloat(), height.toFloat(), Path.Direction.CW)
            if (dragging || !sel.isEmpty) dimPath.addRect(sel, Path.Direction.CW)
            canvas.drawPath(dimPath, dimPaint)
            if (!sel.isEmpty) canvas.drawRect(sel, borderPaint)
        }

        if (!dragging || sel.isEmpty) {
            val hint = when {
                !tapToPick -> "Kéo để chọn vùng chữ · Chạm để huỷ"
                words == null -> "⏳ Đang tìm chữ trên màn hình…"
                words!!.isEmpty() -> "Không thấy chữ nào · Kéo để chọn vùng"
                else -> "Chạm vào một từ · Kéo để chọn vùng"
            }
            canvas.drawText(hint, width / 2f, height * 0.12f, hintPaint)
        }

        if (tapToPick) {
            canvas.drawCircle(closeCx, closeCy, closeR, closeBg)
            val a = closeR * 0.4f
            canvas.drawLine(closeCx - a, closeCy - a, closeCx + a, closeCy + a, closeFg)
            canvas.drawLine(closeCx - a, closeCy + a, closeCx + a, closeCy - a, closeFg)
        }
    }

    private fun inClose(x: Float, y: Float) =
        tapToPick && hypot(x - closeCx, y - closeCy) <= closeR + 8 * density

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        if (finished) return true
        val x = e.x.coerceIn(imgBounds.left, imgBounds.right)
        val y = e.y.coerceIn(imgBounds.top, imgBounds.bottom)
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                pressedClose = inClose(e.x, e.y)
                startX = x; startY = y
                sel.setEmpty()
                dragging = !pressedClose
            }
            MotionEvent.ACTION_MOVE -> {
                if (dragging) sel.set(min(startX, x), min(startY, y), max(startX, x), max(startY, y))
            }
            MotionEvent.ACTION_UP -> {
                dragging = false
                if (pressedClose) {
                    pressedClose = false
                    if (inClose(e.x, e.y)) {
                        // The callback removes this view, so stop here: no further invalidate()/draw.
                        finished = true
                        onCancel()
                        return true
                    }
                } else if (sel.width() < 12 * density || sel.height() < 12 * density) {
                    sel.setEmpty()
                    if (tapToPick) {
                        val p = floatArrayOf(x, y)
                        inverse.mapPoints(p)
                        onTap(p[0], p[1])
                    } else {
                        finished = true
                        onCancel()
                        return true
                    }
                } else {
                    val mapped = RectF(sel)
                    inverse.mapRect(mapped)
                    val r = Rect(
                        mapped.left.toInt().coerceIn(0, shot.width - 1),
                        mapped.top.toInt().coerceIn(0, shot.height - 1),
                        mapped.right.toInt().coerceIn(1, shot.width),
                        mapped.bottom.toInt().coerceIn(1, shot.height),
                    )
                    finished = true
                    onSelected(r)
                    return true
                }
            }
            MotionEvent.ACTION_CANCEL -> {
                dragging = false
                pressedClose = false
                sel.setEmpty()
            }
        }
        invalidate()
        return true
    }
}
