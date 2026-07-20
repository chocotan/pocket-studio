package dev.pocketstudio.mobile

internal data class RemoteTerminalSize(val columns: Int, val rows: Int)

internal class TerminalResizePolicy {
    private var maximumViewportHeight: Int? = null
    private var lastSize: RemoteTerminalSize? = null

    fun stableViewportHeight(currentHeight: Int): Int {
        val height = maxOf(currentHeight, maximumViewportHeight ?: currentHeight)
        maximumViewportHeight = height
        return height
    }

    fun next(columns: Int, currentRows: Int): RemoteTerminalSize? {
        val size = RemoteTerminalSize(columns, currentRows)
        if (size == lastSize) return null
        lastSize = size
        return size
    }
}
