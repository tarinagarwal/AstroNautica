package org.azaadawaaz.app.core

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest

/**
 * The phone-to-phone transfer protocol used over a Wi-Fi Direct socket. Both sides first exchange a one-line JSON
 * hello naming their role, so it doesn't matter which phone became the group owner; the sender then sends a header
 * line (name, size, sha256) and the raw bytes; the receiver checks size and SHA-256 and answers with an ack line.
 * The bundle itself is verified afterwards in TypeScript (signatures and hashes), so this only guards the transfer.
 */
object P2pProtocol {
  const val PROTOCOL = "azaadawaaz-p2p/1"
  const val MAX_BYTES = 8L * 1024 * 1024 * 1024
  private const val MAX_LINE = 64 * 1024

  fun interface Progress {
    fun onProgress(bytes: Long, total: Long)
  }

  fun writeLine(out: OutputStream, o: JSONObject) {
    out.write((o.toString() + "\n").toByteArray(Charsets.UTF_8))
    out.flush()
  }

  fun readLine(input: InputStream): JSONObject {
    val buf = java.io.ByteArrayOutputStream()
    while (true) {
      val b = input.read()
      if (b < 0) throw IOException("connection closed")
      if (b == '\n'.code) break
      buf.write(b)
      if (buf.size() > MAX_LINE) throw IOException("line too long")
    }
    return JSONObject(buf.toString(Charsets.UTF_8.name()))
  }

  /** Exchange hellos; returns the peer's role. Fails if both sides want the same role. */
  fun handshake(input: InputStream, out: OutputStream, role: String): String {
    require(role == "send" || role == "receive")
    writeLine(out, JSONObject().put("proto", PROTOCOL).put("role", role))
    val peer = readLine(input)
    if (peer.optString("proto") != PROTOCOL) throw IOException("the other phone uses a different protocol")
    val peerRole = peer.optString("role")
    if (peerRole == role || (peerRole != "send" && peerRole != "receive")) throw IOException("both phones chose \"$role\"")
    return peerRole
  }

  fun send(input: InputStream, out: OutputStream, file: File, progress: Progress? = null) {
    val size = file.length()
    val sha = Hashing.sha256Hex(file)
    writeLine(out, JSONObject().put("name", file.name).put("size", size).put("sha256", sha))
    var sent = 0L
    file.inputStream().use { src ->
      val buf = ByteArray(256 * 1024)
      while (true) {
        val n = src.read(buf)
        if (n < 0) break
        out.write(buf, 0, n)
        sent += n
        progress?.onProgress(sent, size)
      }
    }
    out.flush()
    val ack = readLine(input)
    if (!ack.optBoolean("ok")) throw IOException("the other phone rejected the file: ${ack.optString("error")}")
  }

  /** Receive one file into destDir; returns (file, sha256). */
  fun receive(input: InputStream, out: OutputStream, destDir: File, progress: Progress? = null): Pair<File, String> {
    val src = if (input is BufferedInputStream) input else BufferedInputStream(input)
    val header = readLine(src)
    val size = header.getLong("size")
    val expected = header.getString("sha256").lowercase()
    if (size < 0 || size > MAX_BYTES) throw IOException("file size not allowed")
    if (!Regex("^[0-9a-f]{64}$").matches(expected)) throw IOException("invalid hash")
    destDir.mkdirs()
    val target = File(destDir, "received-${System.currentTimeMillis()}.zip")
    val md = MessageDigest.getInstance("SHA-256")
    var got = 0L
    try {
      target.outputStream().use { f ->
        val buf = ByteArray(256 * 1024)
        while (got < size) {
          val n = src.read(buf, 0, minOf(buf.size.toLong(), size - got).toInt())
          if (n < 0) throw IOException("connection closed after $got of $size bytes")
          md.update(buf, 0, n)
          f.write(buf, 0, n)
          got += n
          progress?.onProgress(got, size)
        }
      }
      val sha = Hex.encode(md.digest())
      if (!Hashing.hexEquals(sha, expected)) throw IOException("the file was damaged in transfer")
      writeLine(out, JSONObject().put("ok", true))
      return target to sha
    } catch (e: Exception) {
      target.delete()
      runCatching { writeLine(out, JSONObject().put("ok", false).put("error", e.message ?: "error")) }
      throw e
    }
  }
}
