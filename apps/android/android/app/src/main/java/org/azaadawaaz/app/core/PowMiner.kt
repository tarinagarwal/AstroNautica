package org.azaadawaaz.app.core

import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

/**
 * NIP-13 proof-of-work. The caller passes the event serialisation split around the nonce value, so the bytes hashed
 * here are exactly the ones nostr-tools hashes; this only iterates the nonce and counts leading zero bits.
 */
object PowMiner {
  fun leadingZeroBits(hash: ByteArray): Int {
    var count = 0
    for (b in hash) {
      val v = b.toInt() and 0xff
      if (v == 0) {
        count += 8
        continue
      }
      count += Integer.numberOfLeadingZeros(v) - 24
      break
    }
    return count
  }

  /** The first nonce ≥ start whose event id has at least `difficulty` leading zero bits. */
  fun mine(prefix: String, suffix: String, difficulty: Int, start: Long, cancelled: AtomicBoolean = AtomicBoolean(false)): Long {
    require(difficulty in 0..256) { "invalid difficulty" }
    val pre = prefix.toByteArray(Charsets.UTF_8)
    val suf = suffix.toByteArray(Charsets.UTF_8)
    val md = MessageDigest.getInstance("SHA-256")
    var nonce = start
    while (true) {
      if ((nonce and 0x3fff) == 0L && cancelled.get()) throw InterruptedException("cancelled")
      md.update(pre)
      md.update(nonce.toString().toByteArray(Charsets.US_ASCII))
      md.update(suf)
      if (leadingZeroBits(md.digest()) >= difficulty) return nonce
      nonce++
    }
  }
}
