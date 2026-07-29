package dev.pocketstudio.mobile

import android.annotation.SuppressLint
import android.content.Context
import android.view.View
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.termux.view.TerminalView

internal class TerminalViewportPolicy {
    private var normalHeight: Int? = null

    fun terminalHeight(viewportHeight: Int, imeVisible: Boolean): Int {
        if (viewportHeight <= 0) return 0
        if (!imeVisible || normalHeight == null) normalHeight = viewportHeight
        return if (imeVisible) maxOf(viewportHeight, normalHeight ?: viewportHeight) else viewportHeight
    }

    fun verticalOffset(
        viewportHeight: Int,
        terminalHeight: Int,
        cursorRow: Int,
        terminalRows: Int,
        rowHeight: Int,
        followCursor: Boolean,
    ): Int {
        val maximumOffset = (terminalHeight - viewportHeight).coerceAtLeast(0)
        if (!followCursor || maximumOffset == 0 || terminalRows <= 0 || rowHeight <= 0) return 0

        val topInset = (terminalHeight - terminalRows * rowHeight).coerceAtLeast(0)
        val cursorBottom = topInset.toLong() + (cursorRow.coerceAtLeast(0) + 1L) * rowHeight
        return (cursorBottom - viewportHeight).coerceIn(0L, maximumOffset.toLong()).toInt()
    }
}

/** Keeps IME layout changes local instead of resizing the remote terminal grid. */
@SuppressLint("ViewConstructor")
internal class TerminalViewport(
    context: Context,
    private val terminalView: TerminalView,
) : FrameLayout(context) {
    private val policy = TerminalViewportPolicy()
    private val updatePositionRunnable = Runnable(::updateTerminalPosition)

    var isImeVisible: Boolean = false
        private set

    init {
        setBackgroundColor(TerminalLightPalette.backgroundArgb)
        clipChildren = true
        clipToPadding = true
        addView(
            terminalView,
            LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT),
        )
        ViewCompat.setOnApplyWindowInsetsListener(this) { _, insets ->
            updateImeVisibility(insets.isVisible(WindowInsetsCompat.Type.ime()))
            insets
        }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        ViewCompat.requestApplyInsets(this)
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        ViewCompat.getRootWindowInsets(this)?.let { insets ->
            updateImeVisibility(insets.isVisible(WindowInsetsCompat.Type.ime()), relayout = false)
        }

        val width = View.MeasureSpec.getSize(widthMeasureSpec)
        val height = View.MeasureSpec.getSize(heightMeasureSpec)
        setMeasuredDimension(
            View.resolveSize(width, widthMeasureSpec),
            View.resolveSize(height, heightMeasureSpec),
        )

        val contentWidth = (measuredWidth - paddingLeft - paddingRight).coerceAtLeast(0)
        val viewportHeight = (measuredHeight - paddingTop - paddingBottom).coerceAtLeast(0)
        val terminalHeight = policy.terminalHeight(viewportHeight, isImeVisible)
        terminalView.measure(
            View.MeasureSpec.makeMeasureSpec(contentWidth, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(terminalHeight, View.MeasureSpec.EXACTLY),
        )
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        terminalView.layout(
            paddingLeft,
            paddingTop,
            paddingLeft + terminalView.measuredWidth,
            paddingTop + terminalView.measuredHeight,
        )
        updateTerminalPosition()
    }

    fun onScreenUpdated() {
        removeCallbacks(updatePositionRunnable)
        postOnAnimation(updatePositionRunnable)
    }

    fun onTranscriptScrolled() {
        updateTerminalPosition()
    }

    private fun updateImeVisibility(visible: Boolean, relayout: Boolean = true) {
        if (visible == isImeVisible) return
        isImeVisible = visible
        if (relayout) requestLayout()
    }

    private fun updateTerminalPosition() {
        val emulator = terminalView.mEmulator
        val renderer = terminalView.mRenderer
        val viewportHeight = (height - paddingTop - paddingBottom).coerceAtLeast(0)
        val offset = if (emulator == null || renderer == null) {
            0
        } else {
            policy.verticalOffset(
                viewportHeight = viewportHeight,
                terminalHeight = terminalView.height,
                cursorRow = emulator.cursorRow,
                terminalRows = emulator.mRows,
                rowHeight = renderer.fontLineSpacing,
                followCursor = terminalView.topRow == 0,
            )
        }
        terminalView.translationY = -offset.toFloat()
    }
}
