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
import kotlin.math.max
import kotlin.math.min

/**
 * Hiện ảnh chụp màn hình toàn màn hình, cho kéo chọn vùng (giống overlay desktop).
 * Chạm không kéo = huỷ.
 */
@SuppressLint("ViewConstructor")
class SelectionView(
    context: Context,
    private val shot: Bitmap,
    private val onSelected: (Rect) -> Unit,
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

    private val dimPaint = Paint().apply { color = Color.argb(120, 0, 0, 0) }
    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#3B82F6")
        style = Paint.Style.STROKE
        strokeWidth = 2f * density
    }
    private val hintPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = 15f * density
        textAlign = Paint.Align.CENTER
        setShadowLayer(4f, 0f, 0f, Color.BLACK)
    }
    private val dimPath = Path()

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
        canvas.drawColor(Color.BLACK)
        canvas.drawBitmap(shot, drawMatrix, null)

        dimPath.reset()
        dimPath.fillType = Path.FillType.EVEN_ODD
        dimPath.addRect(0f, 0f, width.toFloat(), height.toFloat(), Path.Direction.CW)
        if (dragging || !sel.isEmpty) dimPath.addRect(sel, Path.Direction.CW)
        canvas.drawPath(dimPath, dimPaint)
        if (!sel.isEmpty) canvas.drawRect(sel, borderPaint)

        if (!dragging) {
            canvas.drawText("Kéo để chọn vùng chữ · Chạm để huỷ", width / 2f, height * 0.12f, hintPaint)
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        val x = e.x.coerceIn(imgBounds.left, imgBounds.right)
        val y = e.y.coerceIn(imgBounds.top, imgBounds.bottom)
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                startX = x; startY = y
                sel.setEmpty()
                dragging = true
            }
            MotionEvent.ACTION_MOVE -> {
                sel.set(min(startX, x), min(startY, y), max(startX, x), max(startY, y))
            }
            MotionEvent.ACTION_UP -> {
                dragging = false
                if (sel.width() < 12 * density || sel.height() < 12 * density) {
                    onCancel()
                } else {
                    val mapped = RectF(sel)
                    inverse.mapRect(mapped)
                    val r = Rect(
                        mapped.left.toInt().coerceIn(0, shot.width - 1),
                        mapped.top.toInt().coerceIn(0, shot.height - 1),
                        mapped.right.toInt().coerceIn(1, shot.width),
                        mapped.bottom.toInt().coerceIn(1, shot.height),
                    )
                    onSelected(r)
                }
            }
            MotionEvent.ACTION_CANCEL -> {
                dragging = false
                sel.setEmpty()
            }
        }
        invalidate()
        return true
    }
}
