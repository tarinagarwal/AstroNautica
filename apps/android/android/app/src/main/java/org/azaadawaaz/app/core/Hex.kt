package org.azaadawaaz.app.core

import java.io.File
import java.io.InputStream
import java.security.MessageDigest

/** Small byte helpers shared by the native modules (pure JVM, unit-tested without Android). */
object Hex {
  private val DIGITS = "0123456789abcdef".toCharArray()

  fun encode(bytes: ByteArray): String {
    val out = CharArray(bytes.size * 2)
    for (i in bytes.indices) {
      val v = bytes[i].toInt() and 0xff
      out[i * 2] = DIGITS[v ushr 4]
      out[i * 2 + 1] = DIGITS[v and 0x0f]
    }
    return String(out)
  }

  fun decode(hex: String): ByteArray {
    require(hex.length % 2 == 0 && hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) { "invalid hex" }
    return ByteArray(hex.length / 2) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
  }
}

object Hashing {
  fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

  fun sha256Hex(bytes: ByteArray): String = Hex.encode(sha256(bytes))

  fun sha256Hex(input: InputStream): String {
    val md = MessageDigest.getInstance("SHA-256")
    val buf = ByteArray(256 * 1024)
    while (true) {
      val n = input.read(buf)
      if (n < 0) break
      md.update(buf, 0, n)
    }
    return Hex.encode(md.digest())
  }

  fun sha256Hex(file: File): String = file.inputStream().use { sha256Hex(it) }

  /** Constant-time comparison of two hex strings. */
  fun hexEquals(a: String, b: String): Boolean {
    if (a.length != b.length) return false
    var diff = 0
    for (i in a.indices) diff = diff or (a[i].code xor b[i].code)
    return diff == 0
  }
}

/** An error the JS side can tell apart by its code (rejected promises carry it). */
class CodedException(val code: String, message: String, cause: Throwable? = null) : Exception(message, cause)
