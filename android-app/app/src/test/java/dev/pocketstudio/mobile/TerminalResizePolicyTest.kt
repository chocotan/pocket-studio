package dev.pocketstudio.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalResizePolicyTest {
    @Test fun keyboardHeightChangesDoNotResizeRemoteRows() {
        val policy = TerminalResizePolicy()

        assertEquals(RemoteTerminalSize(51, 42), policy.next(51, 42))
        assertNull(policy.next(51, 18))
        assertEquals(RemoteTerminalSize(60, 42), policy.next(60, 18))
    }
}
