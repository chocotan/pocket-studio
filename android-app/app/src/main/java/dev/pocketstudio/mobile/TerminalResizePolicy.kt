package dev.pocketstudio.mobile

internal data class RemoteTerminalSize(val columns: Int, val rows: Int)

internal class TerminalResizePolicy {
    private var lastSize: RemoteTerminalSize? = null

    fun next(columns: Int, rows: Int, suppress: Boolean = false): RemoteTerminalSize? {
        if (suppress) return null
        val size = RemoteTerminalSize(columns, rows)
        if (size == lastSize) return null
        lastSize = size
        return size
    }
}
