package dev.pocketstudio.mobile

internal data class RemoteTerminalSize(val columns: Int, val rows: Int)

internal class TerminalResizePolicy {
    private var lastSize: RemoteTerminalSize? = null

    fun next(columns: Int, currentRows: Int, freezeRows: Boolean = false): RemoteTerminalSize? {
        val rows = if (freezeRows) lastSize?.rows ?: currentRows else currentRows
        val size = RemoteTerminalSize(columns, rows)
        if (size == lastSize) return null
        lastSize = size
        return size
    }
}
