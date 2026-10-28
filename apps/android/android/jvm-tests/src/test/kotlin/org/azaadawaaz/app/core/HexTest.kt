package org.azaadawaaz.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HexTest {
  @Test fun encodesAndHashes() {
    assertEquals("00ff10", Hex.encode(byteArrayOf(0, -1, 16)))
    assertEquals("00ff10", Hex.encode(Hex.decode("00FF10")))
    assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", Hashing.sha256Hex(ByteArray(0)))
    assertTrue(Hashing.hexEquals("ab", "ab"))
    assertFalse(Hashing.hexEquals("ab", "ac"))
  }
}
