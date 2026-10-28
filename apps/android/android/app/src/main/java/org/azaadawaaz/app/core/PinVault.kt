package org.azaadawaaz.app.core

import org.json.JSONObject
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * The key vault's file format and PIN layer (spec §8.2, §12). The stored blob is always encrypted by an outer cipher
 * (a non-exportable Android Keystore AES-GCM key on the phone). With an app lock, the secrets inside are additionally
 * AES-GCM encrypted with a key derived from the PIN (PBKDF2-HMAC-SHA256), so a copy of the app's files is useless
 * without the PIN even on a rooted phone with the Keystore intact. Wrong PINs are slowed down by a growing pause.
 */
class PinVault(private val outer: OuterCipher, private val store: Store, private val clock: () -> Long = System::currentTimeMillis) {
  interface OuterCipher {
    fun encrypt(plain: ByteArray): ByteArray
    fun decrypt(blob: ByteArray): ByteArray
  }

  interface Store {
    fun read(): String?
    fun write(text: String)
    fun delete()
  }

  companion object {
    const val ITERATIONS = 210_000
    const val MAX_FREE_ATTEMPTS = 5
    private val rng = SecureRandom()

    fun deriveKey(pin: String, salt: ByteArray, iterations: Int = ITERATIONS): ByteArray {
      val spec = PBEKeySpec(pin.toCharArray(), salt, iterations, 256)
      try {
        return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
      } finally {
        spec.clearPassword()
      }
    }

    fun seal(key: ByteArray, plain: ByteArray): ByteArray {
      val iv = ByteArray(12).also { rng.nextBytes(it) }
      val c = Cipher.getInstance("AES/GCM/NoPadding")
      c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
      return iv + c.doFinal(plain)
    }

    /** null when the key is wrong or the data was altered. */
    fun open(key: ByteArray, blob: ByteArray): ByteArray? {
      if (blob.size < 12 + 16) return null
      return try {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, blob, 0, 12))
        c.doFinal(blob, 12, blob.size - 12)
      } catch (e: Exception) {
        null
      }
    }

    /** Same schedule as the TypeScript side (src/security/lock.ts). */
    fun backoffMs(failures: Int): Long = if (failures < MAX_FREE_ATTEMPTS) 0 else minOf(3_600_000L, 30_000L shl minOf(failures - MAX_FREE_ATTEMPTS, 20))

    fun validPin(pin: String) = Regex("^\\d{6,12}$").matches(pin)
  }

  /** The PIN-derived key while unlocked (kept only in memory). */
  @Volatile private var pinKey: ByteArray? = null

  private fun load(): JSONObject? = store.read()?.let { JSONObject(it) }

  val hasVault: Boolean get() = load() != null
  val lock: String get() = load()?.optString("lock", "none") ?: "none"
  val unlocked: Boolean get() = lock == "none" || pinKey != null
  val failedAttempts: Int get() = load()?.optInt("failed", 0) ?: 0
  val retryAt: Long get() = load()?.optLong("retryAt", 0) ?: 0

  fun currentPinKey(): ByteArray? = pinKey

  private fun b64(b: ByteArray) = Base64.getEncoder().encodeToString(b)
  private fun unb64(s: String) = Base64.getDecoder().decode(s)

  private fun save(lockType: String, inner: ByteArray, salt: ByteArray?, failed: Int = 0, retryAt: Long = 0, bio: JSONObject? = null) {
    val o =
      JSONObject()
        .put("v", 1)
        .put("lock", lockType)
        .put("payload", b64(outer.encrypt(inner)))
        .put("failed", failed)
        .put("retryAt", retryAt)
    if (salt != null) o.put("salt", b64(salt)).put("iterations", ITERATIONS)
    if (bio != null) o.put("bio", bio)
    store.write(o.toString())
  }

  /** The secrets JSON ("{}" when none). Throws when locked. */
  fun read(): String {
    val o = load() ?: return "{}"
    val inner = outer.decrypt(unb64(o.getString("payload")))
    if (o.optString("lock") != "pin") return String(inner, Charsets.UTF_8)
    val key = pinKey ?: throw IllegalStateException("the vault is locked")
    return String(open(key, inner) ?: throw IllegalStateException("the vault could not be decrypted"), Charsets.UTF_8)
  }

  fun write(secretsJson: String) {
    JSONObject(secretsJson) // must be JSON
    val o = load()
    val plain = secretsJson.toByteArray(Charsets.UTF_8)
    if (o?.optString("lock") == "pin") {
      val key = pinKey ?: throw IllegalStateException("the vault is locked")
      save("pin", seal(key, plain), unb64(o.getString("salt")), bio = o.optJSONObject("bio"))
    } else save("none", plain, null)
  }

  /** Set or change the PIN (the vault must be unlocked). Biometric unlock must be enabled again afterwards. */
  fun setPin(pin: String) {
    require(validPin(pin)) { "the PIN must have 6 to 12 digits" }
    val secrets = read()
    val salt = ByteArray(16).also { rng.nextBytes(it) }
    val key = deriveKey(pin, salt)
    save("pin", seal(key, secrets.toByteArray(Charsets.UTF_8)), salt)
    pinKey = key
  }

  fun removePin() {
    val secrets = read()
    save("none", secrets.toByteArray(Charsets.UTF_8), null)
    pinKey = null
  }

  data class Attempt(val ok: Boolean, val attemptsLeft: Int, val retryAt: Long)

  fun unlockWithPin(pin: String): Attempt {
    val o = load() ?: return Attempt(true, MAX_FREE_ATTEMPTS, 0)
    if (o.optString("lock") != "pin") return Attempt(true, MAX_FREE_ATTEMPTS, 0)
    val now = clock()
    val failed = o.optInt("failed", 0)
    val retry = o.optLong("retryAt", 0)
    if (retry > now) return Attempt(false, 0, retry)
    val key = deriveKey(pin, unb64(o.getString("salt")), o.optInt("iterations", ITERATIONS))
    val inner = outer.decrypt(unb64(o.getString("payload")))
    if (open(key, inner) != null) {
      pinKey = key
      if (failed != 0) store.write(o.put("failed", 0).put("retryAt", 0).toString())
      return Attempt(true, MAX_FREE_ATTEMPTS, 0)
    }
    val nextFailed = failed + 1
    val nextRetry = backoffMs(nextFailed).let { if (it > 0) now + it else 0 }
    store.write(o.put("failed", nextFailed).put("retryAt", nextRetry).toString())
    return Attempt(false, maxOf(0, MAX_FREE_ATTEMPTS - nextFailed), nextRetry)
  }

  /** Unlock with a PIN key released by biometric authentication. */
  fun unlockWithKey(key: ByteArray): Boolean {
    val o = load() ?: return false
    val inner = outer.decrypt(unb64(o.getString("payload")))
    if (open(key, inner) == null) return false
    pinKey = key
    return true
  }

  /** The biometric-wrapped PIN key ({iv, data}) stored with the vault. */
  fun bio(): JSONObject? = load()?.optJSONObject("bio")

  fun setBio(bio: JSONObject?) {
    val o = load() ?: return
    if (bio == null) o.remove("bio") else o.put("bio", bio)
    store.write(o.toString())
  }

  fun lockNow() {
    pinKey?.fill(0)
    pinKey = null
  }

  fun wipe() {
    lockNow()
    store.delete()
  }
}
