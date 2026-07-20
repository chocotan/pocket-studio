package dev.pocketstudio.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalResizePolicyTest {
    @Test fun viewportExpandsForBuiltInKeysButDoesNotShrinkForKeyboards() {
        val policy = TerminalResizePolicy()

        assertEquals(1980, policy.stableViewportHeight(1980))
        assertEquals(1980, policy.stableViewportHeight(720))
        assertEquals(2240, policy.stableViewportHeight(2240))
        assertEquals(2240, policy.stableViewportHeight(1980))
    }

    @Test fun duplicateRemoteSizesAreIgnored() {
        val policy = TerminalResizePolicy()

        assertEquals(RemoteTerminalSize(51, 42), policy.next(51, 42))
        assertNull(policy.next(51, 42))
        assertEquals(RemoteTerminalSize(60, 42), policy.next(60, 42))
    }
}
