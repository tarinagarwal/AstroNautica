package org.azaadawaaz.app

import android.content.Context
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File

/** content:// URIs for app files handed to other apps (share sheet, package installer) via androidx FileProvider. */
object ShareUris {
  fun authority(context: Context) = "${context.packageName}.files"

  fun forFile(context: Context, file: File): Uri = FileProvider.getUriForFile(context, authority(context), file)
}
