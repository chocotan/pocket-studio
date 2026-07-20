package dev.pocketstudio.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

class TerminalLightPaletteTest {
    @Test
    fun `all terminal text colors meet WCAG AA contrast on beige background`() {
        val textColors = intArrayOf(
            TerminalLightPalette.foregroundArgb,
            TerminalLightPalette.mutedForegroundArgb,
            TerminalLightPalette.accentArgb,
        ) + TerminalLightPalette.ansiColors

        textColors.forEach { color ->
            assertTrue(
                "Contrast was ${contrastRatio(color, TerminalLightPalette.backgroundArgb)} for ${color.toUInt().toString(16)}",
                contrastRatio(color, TerminalLightPalette.backgroundArgb) >= 4.5,
            )
        }
    }

    @Test
    fun `palette defines the standard sixteen ANSI colors`() {
        assertEquals(16, TerminalLightPalette.ansiColors.size)
    }

    private fun contrastRatio(first: Int, second: Int): Double {
        val lighter = max(relativeLuminance(first), relativeLuminance(second))
        val darker = min(relativeLuminance(first), relativeLuminance(second))
        return (lighter + 0.05) / (darker + 0.05)
    }

    private fun relativeLuminance(color: Int): Double {
        val red = linearChannel(color shr 16 and 0xFF)
        val green = linearChannel(color shr 8 and 0xFF)
        val blue = linearChannel(color and 0xFF)
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue
    }

    private fun linearChannel(channel: Int): Double {
        val value = channel / 255.0
        return if (value <= 0.04045) value / 12.92 else ((value + 0.055) / 1.055).pow(2.4)
    }
}
