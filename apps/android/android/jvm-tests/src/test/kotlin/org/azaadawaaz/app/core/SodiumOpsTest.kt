package org.azaadawaaz.app.core

import com.goterl.lazysodium.SodiumJava
import com.goterl.lazysodium.utils.LibraryLoader
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Base64

/** Byte compatibility with packages/core (libsodium-wrappers): vectors made by core open here, and the reverse. */
class SodiumOpsTest {
  private val ops = SodiumOps(SodiumJava(LibraryLoader.Mode.BUNDLED_ONLY))
  private val v = JSONObject(File(System.getProperty("vectorsDir"), "sodium-vectors.json").readText())
  private fun hex(s: String) = Hex.decode(s)
  private fun b64url(s: String) = Base64.getUrlDecoder().decode(s)

  @Test fun derivesTheSameX25519PublicKey() {
    val x = v.getJSONObject("x25519")
    assertEquals(x.getString("publicKey"), Hex.encode(ops.scalarmultBase(hex(x.getString("privateKey")))))
  }

  @Test fun opensCoreSealedBoxesAndWrappedKeys() {
    val s = v.getJSONObject("sealedBox")
    val opened = ops.boxSealOpen(hex(s.getString("sealed")), hex(s.getString("recipientPublic")), hex(s.getString("recipientPrivate")))
    assertEquals(s.getString("message"), Hex.encode(opened!!))
    val w = v.getJSONObject("wrapKey")
    val unwrapped = ops.boxSealOpen(b64url(w.getString("wrapped")), hex(s.getString("recipientPublic")), hex(s.getString("recipientPrivate")))
    assertEquals(w.getString("contentKey"), Hex.encode(unwrapped!!))
  }

  @Test fun sealedBoxFailsWithAnotherKey() {
    val s = v.getJSONObject("sealedBox")
    val (pk, sk) = ops.boxKeypair()
    assertNull(ops.boxSealOpen(hex(s.getString("sealed")), pk, sk))
  }

  @Test fun decryptsCoreSecretstreamChunks() {
    val s = v.getJSONObject("secretstream")
    val id = ops.initPull(hex(s.getString("header")), hex(s.getString("key")))
    assertTrue(id > 0)
    val chunks = s.getJSONArray("chunks")
    val out = java.io.ByteArrayOutputStream()
    var lastTag: Byte = -1
    for (i in 0 until chunks.length()) {
      val (m, tag) = ops.pull(id, hex(chunks.getString(i)))!!
      out.write(m)
      lastTag = tag
      assertEquals(if (i == chunks.length() - 1) SodiumOps.TAG_FINAL else SodiumOps.TAG_MESSAGE, tag)
    }
    assertEquals(SodiumOps.TAG_FINAL, lastTag)
    assertEquals(s.getString("plaintext"), Hex.encode(out.toByteArray()))
  }

  @Test fun detectsTamperedAndReorderedChunks() {
    val s = v.getJSONObject("secretstream")
    val chunks = s.getJSONArray("chunks")
    val tampered = hex(chunks.getString(0)).also { it[5] = (it[5].toInt() xor 1).toByte() }
    assertNull(ops.pull(ops.initPull(hex(s.getString("header")), hex(s.getString("key"))), tampered))
    assertNull(ops.pull(ops.initPull(hex(s.getString("header")), hex(s.getString("key"))), hex(chunks.getString(1))))
  }

  @Test fun decryptsCoreEncryptJson() {
    val e = v.getJSONObject("encryptJson")
    val (h, c) = e.getString("sealed").split(".")
    val id = ops.initPull(b64url(h), hex(e.getString("key")))
    val (m, tag) = ops.pull(id, b64url(c))!!
    assertEquals(SodiumOps.TAG_FINAL, tag)
    assertEquals(e.getString("json"), String(m, Charsets.UTF_8))
  }

  @Test fun decryptsCoreEmptyStream() {
    val e = v.getJSONObject("emptyStream")
    val id = ops.initPull(hex(e.getString("header")), hex(e.getString("key")))
    val (m, tag) = ops.pull(id, hex(e.getJSONArray("chunks").getString(0)))!!
    assertEquals(0, m.size)
    assertEquals(SodiumOps.TAG_FINAL, tag)
  }

  @Test fun fileEncryptionRoundTripsAndMatchesCoreLayout() {
    val dir = Files.createTempDirectory("ss").toFile()
    val src = File(dir, "plain.bin").apply { writeBytes(ByteArray(2_500_123) { (it * 31 + 7).toByte() }) }
    val key = ops.secretstreamKeygen()
    val enc = ops.encryptFile(src, File(dir, "enc"), key, 1 shl 20)
    assertEquals(3, enc.chunks.size)
    assertEquals((1 shl 20) + 17, enc.chunks[0].size)
    assertEquals(2_500_123 - 2 * (1 shl 20) + 17, enc.chunks[2].size)
    assertEquals(Hashing.sha256Hex(src), enc.plainSha256)
    enc.chunks.forEach { assertEquals(it.sha256, Hashing.sha256Hex(File(it.path))) }
    assertArrayEquals(enc.header, File(dir, "enc/header").readBytes())
    val dest = File(dir, "out.bin")
    val (sha, size) = ops.decryptChunks(enc.header, key, enc.chunks.map { File(it.path) }, dest)
    assertEquals(enc.plainSha256, sha)
    assertEquals(src.length(), size)
    // truncation (final chunk missing) and reordering are refused, and nothing is left behind
    try {
      ops.decryptChunks(enc.header, key, enc.chunks.dropLast(1).map { File(it.path) }, File(dir, "t.bin"))
      fail("truncated stream accepted")
    } catch (e: Exception) {
      assertTrue(!File(dir, "t.bin").exists())
    }
    try {
      ops.decryptChunks(enc.header, key, enc.chunks.reversed().map { File(it.path) }, File(dir, "r.bin"))
      fail("reordered stream accepted")
    } catch (_: Exception) {}
    writeVectorsForCore(enc, key, dir)
  }

  /** Output for the reverse check: src/contributor/__tests__/kotlinVectors.test.ts decrypts these with core. */
  private fun writeVectorsForCore(enc: SodiumOps.Encrypted, key: ByteArray, dir: File) {
    val (pk, sk) = ops.boxKeypair()
    val contentKey = ops.secretstreamKeygen()
    val small = "छोटा संदेश from Kotlin".toByteArray()
    val sid = ops.initPush(contentKey)
    val c0 = ops.push(sid.first, small, SodiumOps.TAG_FINAL)
    val firstChunk = File(enc.chunks[0].path).readBytes()
    val o =
      JSONObject()
        .put("x25519", JSONObject().put("publicKey", Hex.encode(pk)).put("privateKey", Hex.encode(sk)))
        .put("wrapped", Base64.getUrlEncoder().withoutPadding().encodeToString(ops.boxSeal(contentKey, pk)))
        .put("contentKey", Hex.encode(contentKey))
        .put("stream", JSONObject().put("header", Hex.encode(sid.second)).put("chunks", JSONArray().put(Hex.encode(c0))).put("plaintext", Hex.encode(small)))
        .put("fileStream", JSONObject().put("key", Hex.encode(key)).put("header", Hex.encode(enc.header)).put("firstChunkSha256", enc.chunks[0].sha256).put("chunkCount", enc.chunks.size).put("plainSha256", enc.plainSha256))
    assertNotNull(firstChunk)
    val out = File(System.getProperty("outDir")).apply { mkdirs() }
    File(out, "kotlin-vectors.json").writeText(o.toString(2))
    dir.deleteRecursively()
  }

  @Test fun freesStatesAfterTheFinalChunkAndCapsLiveStates() {
    val key = ops.secretstreamKeygen()
    val (id, _) = ops.initPush(key)
    ops.push(id, byteArrayOf(1), SodiumOps.TAG_FINAL)
    try {
      ops.push(id, byteArrayOf(2), SodiumOps.TAG_MESSAGE)
      fail("state reused after final")
    } catch (_: IllegalStateException) {}
    val ids = (0 until SodiumOps.MAX_STATES + 10).map { ops.initPush(key).first }
    try {
      ops.push(ids.first(), byteArrayOf(1), SodiumOps.TAG_MESSAGE)
      fail("evicted state still usable")
    } catch (_: IllegalStateException) {}
    ops.push(ids.last(), byteArrayOf(1), SodiumOps.TAG_FINAL)
  }
}
