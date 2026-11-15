package expo.modules.t3phonecontrol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PhoneControlLogicTest {
  @Test
  fun handoffIsTakenOnce() {
    AssistHandoff.offer("  open maps  ", nowMillis = 1_000)
    assertEquals("open maps", AssistHandoff.take(nowMillis = 2_000)?.text)
    assertNull(AssistHandoff.take(nowMillis = 2_000))
  }

  @Test
  fun staleHandoffIsDropped() {
    AssistHandoff.offer("late", nowMillis = 0)
    assertNull(AssistHandoff.take(nowMillis = AssistHandoff.MAX_AGE_MILLIS + 1))
  }

  @Test
  fun statusKeepsOnlyContractKeysWithSafeFallbacks() {
    val values =
      mapOf(
        "companionVersion" to "0.3.0",
        "controlMode" to "unattended",
        "hubConnected" to true,
        "lastRemoteCommandAtMillis" to 42L,
        "lastRemoteCommandKind" to "ui",
        "screenText" to "secret",
      )
    val status = PhoneControlStatus.fromValues { values[it] }
    assertEquals("0.3.0", status["companionVersion"])
    assertEquals("unattended", status["controlMode"])
    assertEquals(true, status["hubConnected"])
    assertEquals(false, status["paused"])
    assertEquals(42L, status["lastRemoteCommandAtMillis"])
    assertEquals(null, status["screenText"])
    assertEquals(10, status.size)
  }

  @Test
  fun unknownModeAndKindFallBack() {
    val status =
      PhoneControlStatus.fromValues { mapOf("controlMode" to "god", "lastRemoteCommandKind" to 3)[it] }
    assertEquals("off", status["controlMode"])
    assertEquals("none", status["lastRemoteCommandKind"])
    assertEquals("unknown", status["companionVersion"])
  }

  @Test
  fun companionPinDecodesToTheReleaseDigest() {
    val bytes = PhoneControlStatus.hexToBytes(PhoneControlStatus.COMPANION_CERT_SHA256)
    assertEquals(32, bytes.size)
    assertEquals(0xf8.toByte(), bytes[0])
    assertEquals(0x89.toByte(), bytes[31])
  }
}
