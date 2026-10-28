package org.azaadawaaz.app.modules

import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import org.azaadawaaz.app.ShareUris
import org.azaadawaaz.app.core.CodedException
import org.azaadawaaz.app.core.Hashing
import org.azaadawaaz.app.specs.NativeAzaadUpdateSpec
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Self-update (spec §8.2): signing certificates of a downloaded APK and of this app, and the system installer. */
class UpdateModule(ctx: ReactApplicationContext) : NativeAzaadUpdateSpec(ctx) {
  private val pm get() = reactApplicationContext.packageManager

  @Suppress("DEPRECATION")
  private fun certs(info: PackageInfo?): List<String> {
    if (info == null) return emptyList()
    val sigs =
      if (Build.VERSION.SDK_INT >= 28) {
        val s = info.signingInfo ?: return emptyList()
        if (s.hasMultipleSigners()) s.apkContentsSigners else s.signingCertificateHistory
      } else info.signatures
    return sigs?.map { Hashing.sha256Hex(it.toByteArray()) } ?: emptyList()
  }

  @Suppress("DEPRECATION")
  private val certFlag = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES

  @Suppress("DEPRECATION")
  override fun appInfo(): String {
    val info = pm.getPackageInfo(reactApplicationContext.packageName, 0)
    val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
    return JSONObject().put("packageName", info.packageName).put("versionName", info.versionName ?: "").put("versionCode", code).toString()
  }

  @Suppress("DEPRECATION")
  override fun apkInfo(path: String, promise: Promise) =
    promise.runIo {
      val f = File(path)
      if (!f.isFile) throw CodedException("not-found", "no such file")
      val info = pm.getPackageArchiveInfo(f.path, certFlag) ?: throw CodedException("invalid", "not a valid APK")
      if (Build.VERSION.SDK_INT < 28) {
        info.applicationInfo?.sourceDir = f.path
        info.applicationInfo?.publicSourceDir = f.path
      }
      val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
      JSONObject()
        .put("packageName", info.packageName)
        .put("versionName", info.versionName ?: "")
        .put("versionCode", code)
        .put("certSha256", JSONArray(certs(info)))
        .toString()
    }

  override fun ownCertSha256(promise: Promise) = promise.runIo { JSONArray(certs(pm.getPackageInfo(reactApplicationContext.packageName, certFlag))).toString() }

  override fun canInstall(promise: Promise) = promise.resolve(Build.VERSION.SDK_INT < 26 || pm.canRequestPackageInstalls())

  override fun openInstallSettings(promise: Promise) {
    if (Build.VERSION.SDK_INT >= 26) {
      reactApplicationContext.startActivity(
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${reactApplicationContext.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
    }
    promise.resolve(null)
  }

  override fun install(path: String, promise: Promise) {
    try {
      val f = File(path).canonicalFile
      if (!f.path.startsWith(reactApplicationContext.cacheDir.canonicalPath + File.separator)) throw CodedException("forbidden", "APK must be in the app cache")
      val uri = ShareUris.forFile(reactApplicationContext, f)
      val intent =
        Intent(Intent.ACTION_VIEW)
          .setDataAndType(uri, "application/vnd.android.package-archive")
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      reactApplicationContext.startActivity(intent)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("error", e.message, e)
    }
  }
}
