package org.azaadawaaz.app.modules

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import org.azaadawaaz.app.Shared
import org.azaadawaaz.app.specs.NativeAzaadSodiumSpec
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Synchronous libsodium for the JS adapter (src/crypto/sodiumAdapter.ts), plus whole-file chunk encryption. */
class SodiumModule(ctx: ReactApplicationContext) : NativeAzaadSodiumSpec(ctx) {
  private val s get() = Shared.sodium

  override fun randomBytes(length: Double): String = s.b64(s.randomBytes(length.toInt().coerceIn(0, 1 shl 20)))

  override fun boxKeypair(): String {
    val (pk, sk) = s.boxKeypair()
    return JSONObject().put("publicKey", s.b64(pk)).put("privateKey", s.b64(sk)).toString()
  }

  override fun scalarmultBase(privateKeyB64: String): String = s.b64(s.scalarmultBase(s.unb64(privateKeyB64)))

  override fun boxSeal(messageB64: String, publicKeyB64: String): String = s.b64(s.boxSeal(s.unb64(messageB64), s.unb64(publicKeyB64)))

  override fun boxSealOpen(cipherB64: String, publicKeyB64: String, privateKeyB64: String): String? =
    s.boxSealOpen(s.unb64(cipherB64), s.unb64(publicKeyB64), s.unb64(privateKeyB64))?.let { s.b64(it) }

  override fun secretstreamKeygen(): String = s.b64(s.secretstreamKeygen())

  override fun secretstreamInitPush(keyB64: String): String {
    val (state, header) = s.initPush(s.unb64(keyB64))
    return JSONObject().put("state", state).put("header", s.b64(header)).toString()
  }

  override fun secretstreamPush(state: Double, messageB64: String, tag: Double): String =
    s.b64(s.push(state.toInt(), s.unb64(messageB64), tag.toInt().toByte()))

  override fun secretstreamInitPull(headerB64: String, keyB64: String): Double = s.initPull(s.unb64(headerB64), s.unb64(keyB64)).toDouble()

  override fun secretstreamPull(state: Double, cipherB64: String): String? =
    s.pull(state.toInt(), s.unb64(cipherB64))?.let { (m, tag) -> JSONObject().put("message", s.b64(m)).put("tag", tag.toInt()).toString() }

  override fun secretstreamFree(state: Double) = s.free(state.toInt())

  override fun encryptFile(requestJson: String, promise: Promise) =
    promise.runIo {
      val o = JSONObject(requestJson)
      val r = s.encryptFile(File(o.getString("src")), File(o.getString("outDir")), s.unb64(o.getString("keyB64")), o.optInt("chunkSize", 1 shl 20))
      val chunks = JSONArray()
      r.chunks.forEach { chunks.put(JSONObject().put("n", it.n).put("size", it.size).put("sha256", it.sha256).put("path", it.path)) }
      JSONObject().put("header", s.b64(r.header)).put("chunks", chunks).put("plainSha256", r.plainSha256).put("plainSize", r.plainSize).toString()
    }

  override fun decryptChunks(requestJson: String, promise: Promise) =
    promise.runIo {
      val o = JSONObject(requestJson)
      val arr = o.getJSONArray("chunkPaths")
      val (sha, size) = s.decryptChunks(s.unb64(o.getString("header")), s.unb64(o.getString("keyB64")), (0 until arr.length()).map { File(arr.getString(it)) }, File(o.getString("dest")))
      JSONObject().put("sha256", sha).put("size", size).toString()
    }
}
