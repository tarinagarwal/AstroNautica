package org.azaadawaaz.app

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  override fun getMainComponentName(): String = "AzaadAwaaz"

  override fun createReactActivityDelegate(): ReactActivityDelegate = DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
    remember(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    remember(intent)
    Shared.onIntent?.invoke()
  }

  /** Files shared or opened with the app (story bundles); links are handled by React Native's Linking. */
  private fun remember(intent: Intent?) {
    intent ?: return
    val uri: Uri? =
      when (intent.action) {
        Intent.ACTION_SEND -> {
          @Suppress("DEPRECATION")
          intent.getParcelableExtra(Intent.EXTRA_STREAM)
        }
        Intent.ACTION_VIEW -> intent.data?.takeIf { it.scheme == "content" || it.scheme == "file" }
        else -> null
      }
    if (uri != null) Shared.pendingIntent = mapOf("action" to (intent.action ?: ""), "uri" to uri.toString(), "mime" to (intent.type ?: ""))
  }
}
