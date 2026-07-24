package dev.pocketstudio.mobile

internal data class RemoteTerminalSize(val columns: Int, val rows: Int)

internal class TerminalResizePolicy {
    private var lastSize: RemoteTerminalSize? = null

    fun next(columns: Int, currentRows: Int): RemoteTerminalSize? {
        val size = RemoteTerminalSize(columns, currentRows)
        if (size == lastSize) return null
        lastSize = size
        return size
    }
}
