package org.azaadawaaz.app

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import javax.crypto.Cipher

/** BiometricPrompt (androidx.biometric) bound to a Keystore cipher: the key is usable only after authentication. */
object BiometricGate {
  fun available(activity: android.content.Context): Boolean =
    BiometricManager.from(activity).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS

  fun authenticate(activity: FragmentActivity, cipher: Cipher, title: String, subtitle: String, cancel: String, done: (Cipher?, String?) -> Unit) {
    activity.runOnUiThread {
      val prompt =
        BiometricPrompt(
          activity,
          ContextCompat.getMainExecutor(activity),
          object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = done(result.cryptoObject?.cipher, null)

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = done(null, errString.toString())
          },
        )
      val info =
        BiometricPrompt.PromptInfo.Builder()
          .setTitle(title)
          .setSubtitle(subtitle)
          .setNegativeButtonText(cancel)
          .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
          .build()
      prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }
  }
}
