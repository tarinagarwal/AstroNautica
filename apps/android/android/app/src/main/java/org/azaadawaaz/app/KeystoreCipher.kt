package org.azaadawaaz.app

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.azaadawaaz.app.core.PinVault
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** A non-exportable AES-256-GCM key in the Android Keystore (StrongBox when the phone has one). */
class KeystoreCipher(private val alias: String, private val requireAuth: Boolean = false) : PinVault.OuterCipher {
  private val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  fun key(): SecretKey {
    (ks.getKey(alias, null) as? SecretKey)?.let { return it }
    fun gen(strongBox: Boolean): SecretKey {
      val spec =
        KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setKeySize(256)
          .apply {
            if (requireAuth) {
              setUserAuthenticationRequired(true)
              setInvalidatedByBiometricEnrollment(true)
              if (Build.VERSION.SDK_INT >= 30) setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
            }
            if (strongBox && Build.VERSION.SDK_INT >= 28) setIsStrongBoxBacked(true)
          }
          .build()
      return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(spec) }.generateKey()
    }
    return try {
      gen(true)
    } catch (e: Exception) {
      gen(false)
    }
  }

  fun deleteKey() {
    if (ks.containsAlias(alias)) ks.deleteEntry(alias)
  }

  fun encryptCipher(): Cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }

  fun decryptCipher(iv: ByteArray): Cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv)) }

  override fun encrypt(plain: ByteArray): ByteArray {
    val c = encryptCipher()
    return c.iv + c.doFinal(plain)
  }

  override fun decrypt(blob: ByteArray): ByteArray = decryptCipher(blob.copyOfRange(0, 12)).doFinal(blob, 12, blob.size - 12)
}
