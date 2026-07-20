package dev.pocketstudio.mobile

internal enum class TerminalScrollMode {
    Transcript,
    MouseWheel,
    RemotePageKeys,
}

internal class TerminalScrollPolicy {
    private var remainderRows = 0f

    fun beginGesture() {
        remainderRows = 0f
    }

    fun mode(alternateBufferActive: Boolean, mouseTrackingActive: Boolean): TerminalScrollMode = when {
        mouseTrackingActive -> TerminalScrollMode.MouseWheel
        alternateBufferActive -> TerminalScrollMode.RemotePageKeys
        else -> TerminalScrollMode.Transcript
    }

    fun dragRows(distanceY: Float, rowHeight: Float): Int {
        remainderRows += distanceY / rowHeight.coerceAtLeast(1f)
        val rows = remainderRows.toInt()
        remainderRows -= rows
        return rows
    }
}
