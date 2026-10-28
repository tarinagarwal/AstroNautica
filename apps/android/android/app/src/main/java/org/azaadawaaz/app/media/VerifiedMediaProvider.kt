package org.azaadawaaz.app.media

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.util.Log
import org.azaadawaaz.app.Shared
import java.io.FileNotFoundException

/**
 * Serves IPFS content to the video player as content://<app>.media/ipfs/<cid>/<path> (spec §8.2 HLS playback). Every
 * block is fetched through the app's network layer (Tor or DoH) with gateway failover and verified against its CID
 * before a byte reaches the player. Using a content provider instead of a loopback HTTP server keeps release builds
 * free of cleartext traffic. Not exported: only this app can open it.
 */
class VerifiedMediaProvider : ContentProvider() {
  override fun onCreate(): Boolean = true

  override fun getType(uri: Uri): String? {
    val p = uri.path ?: return null
    return when {
      p.endsWith(".m3u8") -> "application/vnd.apple.mpegurl"
      p.endsWith(".ts") -> "video/mp2t"
      p.endsWith(".m4s") || p.endsWith(".mp4") -> "video/mp4"
      else -> "application/octet-stream"
    }
  }

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    if (mode != "r") throw FileNotFoundException("read only")
    val segments = uri.pathSegments
    if (segments.size < 2 || segments[0] != "ipfs") throw FileNotFoundException("not an IPFS path")
    val path = segments.drop(1).joinToString("/")
    if (!Regex("^b[a-z2-7]+(/[A-Za-z0-9._-]+)*$").matches(path)) throw FileNotFoundException("invalid IPFS path")
    val (read, write) = ParcelFileDescriptor.createReliablePipe()
    Shared.io.execute {
      try {
        ParcelFileDescriptor.AutoCloseOutputStream(write).use { out -> Shared.ipfs.writePath(path, out) }
      } catch (e: Exception) {
        Log.w("AzaadMedia", "failed to serve $path: ${e.message}")
        runCatching { write.closeWithError(e.message ?: "failed") }
      }
    }
    return read
  }

  override fun query(uri: Uri, p: Array<out String>?, s: String?, a: Array<out String>?, o: String?): Cursor? = null

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null

  override fun delete(uri: Uri, s: String?, a: Array<out String>?): Int = 0

  override fun update(uri: Uri, v: ContentValues?, s: String?, a: Array<out String>?): Int = 0
}
