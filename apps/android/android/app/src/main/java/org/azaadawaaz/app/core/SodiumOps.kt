package org.azaadawaaz.app.core

import com.goterl.lazysodium.Sodium
import com.goterl.lazysodium.interfaces.SecretStream
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.Base64

/**
 * The libsodium operations behind staging encryption (spec §5.2), on lazysodium (SodiumAndroid on the phone,
 * SodiumJava in unit tests, same native libsodium). Byte-compatible with packages/core (libsodium-wrappers): sealed
 * boxes for key wrapping and crypto_secretstream_xchacha20poly1305 in 1 MiB chunks; unit tests decrypt vectors made by
 * core and core decrypts what this produces.
 */
class SodiumOps(private val sodium: Sodium) {
  companion object {
    const val HEADER_BYTES = 24
    const val KEY_BYTES = 32
    const val ABYTES = 17
    const val TAG_MESSAGE: Byte = 0
    const val TAG_FINAL: Byte = 3
    const val MAX_STATES = 256
    private val b64e = Base64.getEncoder()
    private val b64d = Base64.getDecoder()
  }

  private val states =
    object : LinkedHashMap<Int, SecretStream.State>(16, 0.75f, true) {
      override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Int, SecretStream.State>?) = size > MAX_STATES
    }
  private var nextState = 1

  fun randomBytes(n: Int): ByteArray = ByteArray(n).also { sodium.randombytes_buf(it, n) }

  fun boxKeypair(): Pair<ByteArray, ByteArray> {
    val pk = ByteArray(32)
    val sk = ByteArray(32)
    check(sodium.crypto_box_keypair(pk, sk) == 0) { "crypto_box_keypair failed" }
    return pk to sk
  }

  fun scalarmultBase(sk: ByteArray): ByteArray {
    require(sk.size == 32) { "invalid privateKey length" }
    val pk = ByteArray(32)
    check(sodium.crypto_scalarmult_base(pk, sk) == 0) { "crypto_scalarmult_base failed" }
    return pk
  }

  fun boxSeal(message: ByteArray, pk: ByteArray): ByteArray {
    require(pk.size == 32) { "invalid publicKey length" }
    val out = ByteArray(message.size + 48)
    check(sodium.crypto_box_seal(out, message, message.size.toLong(), pk) == 0) { "crypto_box_seal failed" }
    return out
  }

  /** null when the box doesn't open with this key pair. */
  fun boxSealOpen(cipher: ByteArray, pk: ByteArray, sk: ByteArray): ByteArray? {
    if (cipher.size < 48 || pk.size != 32 || sk.size != 32) return null
    val out = ByteArray(cipher.size - 48)
    return if (sodium.crypto_box_seal_open(out, cipher, cipher.size.toLong(), pk, sk) == 0) out else null
  }

  fun secretstreamKeygen(): ByteArray = ByteArray(KEY_BYTES).also { sodium.crypto_secretstream_xchacha20poly1305_keygen(it) }

  @Synchronized
  private fun put(state: SecretStream.State): Int {
    val id = nextState++
    if (nextState == Int.MAX_VALUE) nextState = 1
    states[id] = state
    return id
  }

  @Synchronized
  private fun get(id: Int): SecretStream.State = states[id] ?: throw IllegalStateException("unknown or expired stream state $id")

  @Synchronized
  fun free(id: Int) {
    states.remove(id)
  }

  /** Returns (state handle, header). */
  fun initPush(key: ByteArray): Pair<Int, ByteArray> {
    require(key.size == KEY_BYTES) { "invalid key length" }
    val state = SecretStream.State()
    val header = ByteArray(HEADER_BYTES)
    check(sodium.crypto_secretstream_xchacha20poly1305_init_push(state, header, key) == 0) { "init_push failed" }
    return put(state) to header
  }

  fun push(id: Int, message: ByteArray, tag: Byte): ByteArray {
    val state = get(id)
    val out = ByteArray(message.size + ABYTES)
    check(sodium.crypto_secretstream_xchacha20poly1305_push(state, out, null, message, message.size.toLong(), null, 0, tag) == 0) { "push failed" }
    if (tag == TAG_FINAL) free(id)
    return out
  }

  /** A state handle, or -1 for an invalid header. */
  fun initPull(header: ByteArray, key: ByteArray): Int {
    if (header.size != HEADER_BYTES || key.size != KEY_BYTES) return -1
    val state = SecretStream.State()
    return if (sodium.crypto_secretstream_xchacha20poly1305_init_pull(state, header, key) == 0) put(state) else -1
  }

  /** (plaintext, tag), or null if the chunk fails authentication. */
  fun pull(id: Int, cipher: ByteArray): Pair<ByteArray, Byte>? {
    if (cipher.size < ABYTES) return null
    val state = get(id)
    val out = ByteArray(cipher.size - ABYTES)
    val tag = ByteArray(1)
    if (sodium.crypto_secretstream_xchacha20poly1305_pull(state, out, null, tag, cipher, cipher.size.toLong(), null, 0) != 0) return null
    if (tag[0] == TAG_FINAL) free(id)
    return out to tag[0]
  }

  // ---- whole files (large media never passes through JS) ----

  data class Chunk(val n: Int, val size: Int, val sha256: String, val path: String)

  data class Encrypted(val header: ByteArray, val chunks: List<Chunk>, val plainSha256: String, val plainSize: Long)

  /** Encrypt `src` into `outDir/header` and `outDir/<n>` chunk files, exactly like core `encryptBytes`. */
  fun encryptFile(src: File, outDir: File, key: ByteArray, chunkSize: Int): Encrypted {
    require(chunkSize > 0) { "invalid chunk size" }
    outDir.mkdirs()
    val total = src.length()
    val (id, header) = initPush(key)
    File(outDir, "header").writeBytes(header)
    val plainMd = MessageDigest.getInstance("SHA-256")
    val chunks = ArrayList<Chunk>()
    try {
      src.inputStream().buffered(1 shl 20).use { input ->
        var offset = 0L
        var n = 0
        if (total == 0L) {
          val c = push(id, ByteArray(0), TAG_FINAL)
          chunks += writeChunk(outDir, 0, c)
        }
        while (offset < total) {
          val len = minOf(chunkSize.toLong(), total - offset).toInt()
          val buf = ByteArray(len)
          var read = 0
          while (read < len) {
            val r = input.read(buf, read, len - read)
            if (r < 0) throw IOException("file shrank while encrypting")
            read += r
          }
          plainMd.update(buf)
          offset += len
          val c = push(id, buf, if (offset == total) TAG_FINAL else TAG_MESSAGE)
          chunks += writeChunk(outDir, n++, c)
        }
      }
    } finally {
      free(id)
    }
    return Encrypted(header, chunks, Hex.encode(plainMd.digest()), total)
  }

  private fun writeChunk(dir: File, n: Int, bytes: ByteArray): Chunk {
    val f = File(dir, n.toString())
    f.writeBytes(bytes)
    return Chunk(n, bytes.size, Hashing.sha256Hex(bytes), f.absolutePath)
  }

  /** Decrypt chunk files in order into `dest`; fails on tampering, reordering, truncation or trailing chunks. */
  fun decryptChunks(header: ByteArray, key: ByteArray, chunkPaths: List<File>, dest: File): Pair<String, Long> {
    val id = initPull(header, key)
    if (id < 0) throw IOException("invalid secretstream header")
    val md = MessageDigest.getInstance("SHA-256")
    var size = 0L
    var finished = false
    val tmp = File(dest.parentFile, dest.name + ".part")
    try {
      tmp.outputStream().buffered(1 shl 20).use { out ->
        for (p in chunkPaths) {
          if (finished) throw IOException("data after the final chunk")
          val (plain, tag) = pull(id, p.readBytes()) ?: throw IOException("chunk ${p.name} failed authentication")
          md.update(plain)
          out.write(plain)
          size += plain.size
          if (tag == TAG_FINAL) finished = true
        }
      }
      if (!finished) throw IOException("stream truncated: final chunk missing")
      if (dest.exists()) dest.delete()
      if (!tmp.renameTo(dest)) throw IOException("cannot move decrypted file into place")
    } catch (e: Exception) {
      tmp.delete()
      throw e
    } finally {
      free(id)
    }
    return Hex.encode(md.digest()) to size
  }

  fun b64(b: ByteArray): String = b64e.encodeToString(b)

  fun unb64(s: String): ByteArray = b64d.decode(s)
}
