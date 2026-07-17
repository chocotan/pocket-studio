package dev.pocketstudio.mobile

internal data class RemoteTerminalSize(val columns: Int, val rows: Int)

internal class TerminalResizePolicy {
    private var initialViewportHeight: Int? = null
    private var lastSize: RemoteTerminalSize? = null

    fun fixedViewportHeight(currentHeight: Int): Int =
        initialViewportHeight ?: currentHeight.also { initialViewportHeight = it }

    fun next(columns: Int, currentRows: Int): RemoteTerminalSize? {
        val size = RemoteTerminalSize(columns, currentRows)
        if (size == lastSize) return null
        lastSize = size
        return size
    }
}
