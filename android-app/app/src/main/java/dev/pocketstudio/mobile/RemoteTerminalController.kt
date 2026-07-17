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
import kotlin.math.max
import kotlin.math.roundToInt

class RemoteTerminalController(
    context: Context,
    private val url: String,
    private val onConnected: () -> Unit,
    private val onClosed: () -> Unit,
    private val onError: (String) -> Unit,
) {
    val view = TerminalView(context, null)
    private var socket: WebSocket? = null
    private val resizePolicy = TerminalResizePolicy()
    private var scrollRemainder = 0f
    private var controlModifier = false
    private var altModifier = false
    private var metaModifier = false

    private val remoteOutput = object : TerminalOutput() {
        override fun write(data: ByteArray, offset: Int, count: Int) {
            if (isMouseReport(data, offset, count)) return
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
            RemoteTerminalEmulator.install(
                session,
                view,
                remoteOutput,
                current.mColumns,
                current.mRows,
                5000,
                sessionClient,
            )
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
            val rowHeight = max(1f, view.height.toFloat() / max(1, emulator.mRows))
            scrollRemainder += distanceY / rowHeight
            val rows = scrollRemainder.toInt()
            if (rows == 0) return true
            scrollRemainder -= rows
            val historyRows = emulator.screen.activeTranscriptRows
            if (historyRows > 0 && !emulator.isAlternateBufferActive) {
                view.topRow = (view.topRow + rows).coerceIn(-historyRows, 0)
                view.onScreenUpdated()
            } else {
                send(if (rows < 0) "\u001b[5~" else "\u001b[6~")
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
            scrollDetector.onTouchEvent(event)
            false
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
    fun clear() { session.reset(); view.onScreenUpdated() }
    fun close() { socket?.close(1000, "leave terminal"); socket = null; session.finishIfRunning() }

    private fun isMouseReport(data: ByteArray, offset: Int, count: Int): Boolean {
        if (count < 3 || data[offset] != 0x1b.toByte() || data[offset + 1] != '['.code.toByte()) return false
        if (data[offset + 2] == 'M'.code.toByte()) return count == 6
        if (data[offset + 2] != '<'.code.toByte()) return false
        val finalByte = data[offset + count - 1]
        if (finalByte != 'M'.code.toByte() && finalByte != 'm'.code.toByte()) return false
        return (offset + 3 until offset + count - 1).all { index ->
            data[index] in '0'.code.toByte()..'9'.code.toByte() || data[index] == ';'.code.toByte()
        }
    }

    private fun sendResizeIfChanged() {
        if (socket == null) return
        val emulator = session.emulator ?: return
        val rows = resizePolicy.fixedRows(emulator.mRows)
        if (emulator.mRows != rows) {
            emulator.resize(
                emulator.mColumns,
                rows,
                max(1, view.mRenderer.fontWidth.roundToInt()),
                max(1, view.mRenderer.fontLineSpacing),
            )
        }
        val size = resizePolicy.next(emulator.mColumns, emulator.mRows) ?: return
        socket?.send("{\"type\":\"resize\",\"cols\":${size.columns},\"rows\":${size.rows}}")
    }
}
