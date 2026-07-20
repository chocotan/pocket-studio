package dev.pocketstudio.mobile

import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TextStyle

internal object TerminalLightPalette {
    val backgroundArgb = 0xFFF4EBDD.toInt()
    val surfaceArgb = 0xFFFAF4E8.toInt()
    val keycapArgb = 0xFFE8DCC7.toInt()
    val borderArgb = 0xFF8E7D63.toInt()
    val dividerArgb = 0xFFCBBDA4.toInt()
    val foregroundArgb = 0xFF39342C.toInt()
    val mutedForegroundArgb = 0xFF6A6257.toInt()
    val accentArgb = 0xFF006D5D.toInt()
    val onAccentArgb = 0xFFFFFFFF.toInt()

    val ansiColors = intArrayOf(
        0xFF2F2B25.toInt(),
        0xFFA3333F.toInt(),
        0xFF356A42.toInt(),
        0xFF7A5B17.toInt(),
        0xFF355E8A.toInt(),
        0xFF754D73.toInt(),
        0xFF2C6868.toInt(),
        0xFF5C554B.toInt(),
        0xFF72695D.toInt(),
        0xFFA92F3A.toInt(),
        0xFF2F7042.toInt(),
        0xFF745711.toInt(),
        0xFF2F6098.toInt(),
        0xFF7B4778.toInt(),
        0xFF246A70.toInt(),
        0xFF49433A.toInt(),
    )

    fun applyTo(emulator: TerminalEmulator) {
        val colors = emulator.mColors.mCurrentColors
        ansiColors.copyInto(colors)
        colors[TextStyle.COLOR_INDEX_FOREGROUND] = foregroundArgb
        colors[TextStyle.COLOR_INDEX_BACKGROUND] = backgroundArgb
        colors[TextStyle.COLOR_INDEX_CURSOR] = accentArgb
    }
}
