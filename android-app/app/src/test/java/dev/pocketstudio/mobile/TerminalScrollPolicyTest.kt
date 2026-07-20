package dev.pocketstudio.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class TerminalScrollPolicyTest {
    @Test
    fun `normal buffer uses transcript scrolling`() {
        val policy = TerminalScrollPolicy()

        assertEquals(TerminalScrollMode.Transcript, policy.mode(alternateBufferActive = false, mouseTrackingActive = false))
    }

    @Test
    fun `mouse tracking applications use terminal wheel events`() {
        val policy = TerminalScrollPolicy()

        assertEquals(TerminalScrollMode.MouseWheel, policy.mode(alternateBufferActive = true, mouseTrackingActive = true))
    }

    @Test
    fun `alternate screen without mouse tracking uses remote page keys`() {
        val policy = TerminalScrollPolicy()

        assertEquals(TerminalScrollMode.RemotePageKeys, policy.mode(alternateBufferActive = true, mouseTrackingActive = false))
    }

    @Test
    fun `drag accumulates partial rows`() {
        val policy = TerminalScrollPolicy()

        assertEquals(0, policy.dragRows(-8f, 20f))
        assertEquals(-1, policy.dragRows(-12f, 20f))
        assertEquals(2, policy.dragRows(40f, 20f))
    }

    @Test
    fun `new gesture clears the partial row remainder`() {
        val policy = TerminalScrollPolicy()
        policy.dragRows(15f, 20f)

        policy.beginGesture()

        assertEquals(0, policy.dragRows(5f, 20f))
    }
}
