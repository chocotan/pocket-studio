package dev.pocketstudio.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalResizePolicyTest {
    @Test fun realViewportRowChangesAreForwardedAndDuplicatesAreIgnored() {
        val policy = TerminalResizePolicy()

        assertEquals(RemoteTerminalSize(51, 42), policy.next(51, 42))
        assertNull(policy.next(51, 42))
        assertEquals(RemoteTerminalSize(60, 42), policy.next(60, 42))
        assertEquals(RemoteTerminalSize(60, 18), policy.next(60, 18))
        assertNull(policy.next(60, 18))
    }

    @Test fun imeSuppressesAllResizeEventsWithoutReplacingTheLastRemoteSize() {
        val policy = TerminalResizePolicy()

        assertEquals(RemoteTerminalSize(51, 42), policy.next(51, 42))
        assertNull(policy.next(51, 18, suppress = true))
        assertNull(policy.next(60, 18, suppress = true))
        assertNull(policy.next(51, 42))
        assertEquals(RemoteTerminalSize(60, 42), policy.next(60, 42))
    }

    @Test fun firstRealSizeIsSentAfterInitialSuppression() {
        val policy = TerminalResizePolicy()

        assertNull(policy.next(51, 18, suppress = true))
        assertEquals(RemoteTerminalSize(51, 42), policy.next(51, 42))
    }
}
