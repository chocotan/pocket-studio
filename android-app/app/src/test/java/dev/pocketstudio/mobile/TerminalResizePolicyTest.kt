package dev.pocketstudio.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalResizePolicyTest {
    @Test fun visibleViewportRowChangesAreForwardedAndDuplicatesAreIgnored() {
        val policy = TerminalResizePolicy()

        assertEquals(RemoteTerminalSize(51, 42), policy.next(51, 42))
        assertNull(policy.next(51, 42))
        assertEquals(RemoteTerminalSize(60, 42), policy.next(60, 42))
        assertEquals(RemoteTerminalSize(60, 18), policy.next(60, 18))
        assertNull(policy.next(60, 18))
    }
}
