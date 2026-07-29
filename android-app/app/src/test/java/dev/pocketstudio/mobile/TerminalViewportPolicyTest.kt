package dev.pocketstudio.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class TerminalViewportPolicyTest {
    @Test fun imeUsesTheLastNormalTerminalHeight() {
        val policy = TerminalViewportPolicy()

        assertEquals(840, policy.terminalHeight(840, imeVisible = false))
        assertEquals(840, policy.terminalHeight(360, imeVisible = true))
        assertEquals(840, policy.terminalHeight(600, imeVisible = true))
        assertEquals(700, policy.terminalHeight(700, imeVisible = false))
    }

    @Test fun viewportPansOnlyEnoughToKeepTheCursorVisible() {
        val policy = TerminalViewportPolicy()

        assertEquals(0, policy.verticalOffset(360, 840, 0, 42, 20, followCursor = true))
        assertEquals(0, policy.verticalOffset(360, 840, 17, 42, 20, followCursor = true))
        assertEquals(20, policy.verticalOffset(360, 840, 18, 42, 20, followCursor = true))
        assertEquals(480, policy.verticalOffset(360, 840, 41, 42, 20, followCursor = true))
    }

    @Test fun transcriptScrollingShowsTheTopOfTheTerminalCanvas() {
        val policy = TerminalViewportPolicy()

        assertEquals(0, policy.verticalOffset(360, 840, 41, 42, 20, followCursor = false))
    }
}
