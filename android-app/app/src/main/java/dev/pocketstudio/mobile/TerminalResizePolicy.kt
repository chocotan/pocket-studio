package dev.pocketstudio.mobile

internal data class RemoteTerminalSize(val columns: Int, val rows: Int)

internal class TerminalResizePolicy {
    private var initialRows: Int? = null
    private var lastSize: RemoteTerminalSize? = null

    fun fixedRows(currentRows: Int): Int = initialRows ?: currentRows.also { initialRows = it }

    fun next(columns: Int, currentRows: Int): RemoteTerminalSize? {
        val size = RemoteTerminalSize(columns, fixedRows(currentRows))
        if (size == lastSize) return null
        lastSize = size
        return size
    }
}
