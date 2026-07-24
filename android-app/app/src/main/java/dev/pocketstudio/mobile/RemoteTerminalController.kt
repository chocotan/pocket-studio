package dev.pocketstudio.mobile

import android.content.Context
import android.util.Log
import android.view.GestureDetector
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.inputmethod.InputMethodManager
import com.termux.terminal.KeyHandler
import com.termux.terminal.RemoteTerminalEmulator
import com.termux.terminal.TerminalOutput
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import com.termux.view.TerminalView
import com.termux.view.TerminalViewClient
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.nio.charset.StandardCharsets
import kotlin.math.abs

class RemoteTerminalController(
    context: Context,
    private val url: String,
    private val onConnected: () -> Unit,
    private val onClosed: () -> Unit,
    private val onError: (String) -> Unit,
) {
    val view = TerminalView(context, null).apply {
        setBackgroundColor(TerminalLightPalette.backgroundArgb)
    }
    private var socket: WebSocket? = null
    private val resizePolicy = TerminalResizePolicy()
    private val scrollPolicy = TerminalScrollPolicy()
    private var scrollGestureConsumed = false
    private var cancelTermuxGesture = false
    private var controlModifier = false
    private var altModifier = false
    private var metaModifier = false

    private val remoteOutput = object : TerminalOutput() {
        override fun write(data: ByteArray, offset: Int, count: Int) {
            socket?.send(data.toByteString(offset, count))
        }

        override fun titleChanged(oldTitle: String?, newTitle: String?) = Unit
        override fun onCopyTextToClipboard(text: String) = Unit
        override fun onPasteTextFromClipboard() = Unit
        override fun onBell() = view.performHapticFeedback(1).let { Unit }
        override fun onColorsChanged() = view.postInvalidate()
    }

    private val sessionClient = object : TerminalSessionClient {
        override fun onTextChanged(session: TerminalSession) = view.onScreenUpdated()
        override fun onTitleChanged(session: TerminalSession) = Unit
        override fun onSessionFinished(session: TerminalSession) = Unit
        override fun onCopyTextToClipboard(session: TerminalSession, text: String) = Unit
        override fun onPasteTextFromClipboard(session: TerminalSession) = Unit
        override fun onBell(session: TerminalSession) { view.performHapticFeedback(1) }
        override fun onColorsChanged(session: TerminalSession) = view.invalidate()
        override fun onTerminalCursorStateChange(state: Boolean) = view.invalidate()
        override fun getTerminalCursorStyle(): Int = 0
        override fun logError(tag: String, message: String) { Log.e(tag, message) }
        override fun logWarn(tag: String, message: String) { Log.w(tag, message) }
        override fun logInfo(tag: String, message: String) { Log.i(tag, message) }
        override fun logDebug(tag: String, message: String) { Log.d(tag, message) }
        override fun logVerbose(tag: String, message: String) { Log.v(tag, message) }
        override fun logStackTraceWithMessage(tag: String, message: String, e: Exception) { Log.e(tag, message, e) }
        override fun logStackTrace(tag: String, e: Exception) { Log.e(tag, "Terminal error", e) }
    }

    private val viewClient = object : TerminalViewClient {
        override fun onScale(scale: Float) = scale.coerceIn(0.7f, 1.8f)
        override fun onSingleTapUp(e: MotionEvent) = showKeyboard()
        override fun shouldBackButtonBeMappedToEscape() = false
        override fun shouldEnforceCharBasedInput() = true
        override fun shouldUseCtrlSpaceWorkaround() = false
        override fun isTerminalViewSelected() = true
        override fun copyModeChanged(copyMode: Boolean) = Unit
        override fun onKeyDown(keyCode: Int, e: KeyEvent, session: TerminalSession): Boolean {
            val modifiers = (if (e.isCtrlPressed) KeyHandler.KEYMOD_CTRL else 0) or
                (if (e.isAltPressed) KeyHandler.KEYMOD_ALT else 0) or
                (if (e.isShiftPressed) KeyHandler.KEYMOD_SHIFT else 0)
            val emulator = session.emulator
            val code = KeyHandler.getCode(keyCode, modifiers, emulator?.isCursorKeysApplicationMode ?: false, emulator?.isKeypadApplicationMode ?: false)
            if (code != null) send(code)
            return code != null
        }
        override fun onKeyUp(keyCode: Int, e: KeyEvent) = true
        override fun onLongPress(event: MotionEvent) = false
        override fun readControlKey() = controlModifier
        override fun readAltKey() = altModifier
        override fun readShiftKey() = false
        override fun readFnKey() = false
        override fun onCodePoint(codePoint: Int, ctrlDown: Boolean, session: TerminalSession): Boolean {
            val value = if (ctrlDown && codePoint in 64..127) codePoint and 31 else codePoint
            send((if (altModifier || metaModifier) "\u001b" else "") + String(Character.toChars(value)))
            return true
        }
        override fun onEmulatorSet() {
            val current = session.emulator ?: return
            val emulator = RemoteTerminalEmulator.install(
                session,
                view,
                remoteOutput,
                current.mColumns,
                current.mRows,
                5000,
                sessionClient,
            )
            TerminalLightPalette.applyTo(emulator)
            connect()
        }
        override fun logError(tag: String, message: String) { Log.e(tag, message) }
        override fun logWarn(tag: String, message: String) { Log.w(tag, message) }
        override fun logInfo(tag: String, message: String) { Log.i(tag, message) }
        override fun logDebug(tag: String, message: String) { Log.d(tag, message) }
        override fun logVerbose(tag: String, message: String) { Log.v(tag, message) }
        override fun logStackTraceWithMessage(tag: String, message: String, e: Exception) { Log.e(tag, message, e) }
        override fun logStackTrace(tag: String, e: Exception) { Log.e(tag, "Terminal error", e) }
    }

    private val session = TerminalSession(
        "/system/bin/cat", "/", arrayOf("/system/bin/cat"), arrayOf("PATH=/system/bin"), 5000, sessionClient,
    )

    private val scrollDetector = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent) = true

        override fun onScroll(e1: MotionEvent?, e2: MotionEvent, distanceX: Float, distanceY: Float): Boolean {
            val emulator = session.emulator ?: return false
            if (e2.pointerCount != 1 || abs(distanceY) <= abs(distanceX)) return false
            if (!scrollGestureConsumed) {
                scrollGestureConsumed = true
                cancelTermuxGesture = true
            }
            val rows = scrollPolicy.dragRows(
                distanceY = distanceY,
                rowHeight = view.height.toFloat() / emulator.mRows.coerceAtLeast(1),
            )
            if (rows == 0) return true
            when (scrollPolicy.mode(emulator.isAlternateBufferActive, emulator.isMouseTrackingActive)) {
                TerminalScrollMode.Transcript -> {
                    val historyRows = emulator.screen.activeTranscriptRows
                    view.topRow = (view.topRow + rows).coerceIn(-historyRows, 0)
                    view.invalidate()
                }
                TerminalScrollMode.MouseWheel -> {
                    val cell = view.getColumnAndRow(e2, false)
                    val button = if (rows < 0) 64 else 65
                    repeat(abs(rows)) { emulator.sendMouseEvent(button, cell[0] + 1, cell[1] + 1, true) }
                }
                TerminalScrollMode.RemotePageKeys -> {
                    val key = if (rows < 0) "\u001b[5~" else "\u001b[6~"
                    repeat(abs(rows)) { send(key) }
                }
            }
            return true
        }
    })

    init {
        view.setTerminalViewClient(viewClient)
        view.setTextSize((14 * context.resources.displayMetrics.density).toInt())
        view.isFocusableInTouchMode = true
        view.attachSession(session)
        view.setOnTouchListener { _, event ->
            if (event.actionMasked == MotionEvent.ACTION_DOWN) {
                scrollPolicy.beginGesture()
                scrollGestureConsumed = false
                cancelTermuxGesture = false
            }
            scrollDetector.onTouchEvent(event)
            if (cancelTermuxGesture) {
                MotionEvent.obtain(event).also { cancelEvent ->
                    cancelEvent.action = MotionEvent.ACTION_CANCEL
                    view.onTouchEvent(cancelEvent)
                    cancelEvent.recycle()
                }
                cancelTermuxGesture = false
            }
            val consumed = scrollGestureConsumed
            if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
                scrollGestureConsumed = false
                cancelTermuxGesture = false
            }
            consumed
        }
        view.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> sendResizeIfChanged() }
    }

    private fun connect() {
        if (socket != null) return
        socket = OkHttpClient().newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { view.post { onConnected(); sendResizeIfChanged() } }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) { append(bytes.toByteArray()) }
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (!text.trimStart().startsWith("{")) append(text.toByteArray(StandardCharsets.UTF_8))
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { view.post { onError(t.message ?: "终端连接失败") } }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { view.post(onClosed) }
        })
    }

    private fun append(bytes: ByteArray) = view.post {
        session.emulator?.append(bytes, bytes.size)
        view.onScreenUpdated()
    }

    fun send(value: String) { socket?.send(ByteString.of(*value.toByteArray(StandardCharsets.UTF_8))) }
    fun setControlModifier(enabled: Boolean) { controlModifier = enabled }
    fun setAltModifier(enabled: Boolean) { altModifier = enabled }
    fun setMetaModifier(enabled: Boolean) { metaModifier = enabled }
    fun showKeyboard() {
        view.requestFocus()
        (view.context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(view, InputMethodManager.SHOW_IMPLICIT)
    }
    fun clear() {
        session.reset()
        session.emulator?.let(TerminalLightPalette::applyTo)
        view.onScreenUpdated()
    }
    fun close() { socket?.close(1000, "leave terminal"); socket = null; session.finishIfRunning() }

    private fun sendResizeIfChanged() {
        if (socket == null) return
        val emulator = session.emulator ?: return
        val size = resizePolicy.next(emulator.mColumns, emulator.mRows) ?: return
        socket?.send("{\"type\":\"resize\",\"cols\":${size.columns},\"rows\":${size.rows}}")
    }
}
