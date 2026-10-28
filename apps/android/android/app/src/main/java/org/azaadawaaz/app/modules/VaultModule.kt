package org.azaadawaaz.app.modules

import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import org.azaadawaaz.app.BiometricGate
import org.azaadawaaz.app.KeystoreCipher
import org.azaadawaaz.app.core.PinVault
import org.azaadawaaz.app.specs.NativeAzaadVaultSpec
import org.json.JSONObject
import java.io.File
import java.util.Base64

/**
 * Keys in the Android Keystore (spec §8.2): the vault file is encrypted with a Keystore AES key; with an app lock the
 * secrets are also encrypted under a PIN-derived key, and biometric unlock releases that PIN key through a second,
 * biometric-bound Keystore key (BiometricPrompt CryptoObject).
 */
class VaultModule(ctx: ReactApplicationContext) : NativeAzaadVaultSpec(ctx) {
  private val file = File(ctx.noBackupFilesDir, "vault.json")
  private val outer = KeystoreCipher("azaad_vault")
  private val bioCipher = KeystoreCipher("azaad_vault_bio", requireAuth = true)
  private val vault =
    PinVault(
      outer,
      object : PinVault.Store {
        override fun read(): String? = if (file.isFile) file.readText() else null

        override fun write(text: String) {
          val tmp = File(file.parentFile, "vault.json.tmp")
          tmp.writeText(text)
          if (!tmp.renameTo(file)) {
            file.writeText(text)
            tmp.delete()
          }
        }

        override fun delete() {
          file.delete()
        }
      },
    )

  private fun activity(): FragmentActivity? = reactApplicationContext.currentActivity as? FragmentActivity

  override fun state(promise: Promise) =
    promise.runIo {
      JSONObject()
        .put("hasVault", vault.hasVault)
        .put("lock", vault.lock)
        .put("biometric", vault.bio() != null)
        .put("biometricAvailable", runCatching { BiometricGate.available(reactApplicationContext) }.getOrDefault(false))
        .put("unlocked", vault.unlocked)
        .put("failedAttempts", vault.failedAttempts)
        .put("retryAt", vault.retryAt)
        .toString()
    }

  override fun write(secretsJson: String, promise: Promise) = promise.runIo { vault.write(secretsJson) }

  override fun read(promise: Promise) = promise.runIo { vault.read() }

  override fun setPin(pin: String, promise: Promise) =
    promise.runIo {
      vault.setPin(pin)
      vault.setBio(null)
      bioCipher.deleteKey()
    }

  override fun removePin(promise: Promise) =
    promise.runIo {
      vault.removePin()
      vault.setBio(null)
      bioCipher.deleteKey()
    }

  override fun unlockWithPin(pin: String, promise: Promise) =
    promise.runIo {
      val r = vault.unlockWithPin(pin)
      JSONObject().put("ok", r.ok).put("attemptsLeft", r.attemptsLeft).put("retryAt", r.retryAt).toString()
    }

  override fun enableBiometric(title: String, subtitle: String, cancel: String, promise: Promise) {
    val key = vault.currentPinKey() ?: return promise.reject("locked", "unlock with the PIN first")
    val act = activity() ?: return promise.reject("no-activity", "no activity")
    val cipher =
      try {
        bioCipher.deleteKey()
        bioCipher.encryptCipher()
      } catch (e: Exception) {
        return promise.reject("error", e.message, e)
      }
    BiometricGate.authenticate(act, cipher, title, subtitle, cancel) { c, err ->
      if (c == null) return@authenticate promise.resolve(false).also { if (err != null) android.util.Log.i("AzaadVault", err) }
      try {
        val data = c.doFinal(key)
        vault.setBio(JSONObject().put("iv", Base64.getEncoder().encodeToString(c.iv)).put("data", Base64.getEncoder().encodeToString(data)))
        promise.resolve(true)
      } catch (e: Exception) {
        promise.reject("error", e.message, e)
      }
    }
  }

  override fun disableBiometric(promise: Promise) =
    promise.runIo {
      vault.setBio(null)
      bioCipher.deleteKey()
    }

  override fun unlockWithBiometric(title: String, subtitle: String, cancel: String, promise: Promise) {
    val bio = vault.bio() ?: return promise.resolve(false)
    val act = activity() ?: return promise.reject("no-activity", "no activity")
    val cipher =
      try {
        bioCipher.decryptCipher(Base64.getDecoder().decode(bio.getString("iv")))
      } catch (e: Exception) {
        // A new fingerprint enrolment invalidates the key: fall back to the PIN.
        vault.setBio(null)
        return promise.resolve(false)
      }
    BiometricGate.authenticate(act, cipher, title, subtitle, cancel) { c, _ ->
      if (c == null) return@authenticate promise.resolve(false)
      try {
        promise.resolve(vault.unlockWithKey(c.doFinal(Base64.getDecoder().decode(bio.getString("data")))))
      } catch (e: Exception) {
        promise.resolve(false)
      }
    }
  }

  override fun lock() = vault.lockNow()

  override fun wipe(promise: Promise) =
    promise.runIo {
      vault.wipe()
      bioCipher.deleteKey()
      outer.deleteKey()
    }
}
