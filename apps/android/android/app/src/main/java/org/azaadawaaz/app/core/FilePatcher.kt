package org.azaadawaaz.app.core

import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.util.Base64

/**
 * Applies the byte patches the JS metadata stripper planned for a large video (bmffSkeleton.ts): copy the file, then
 * overwrite ranges with given bytes or zeros, then optionally truncate. Sizes and offsets are checked first.
 */
object FilePatcher {
  data class Patch(val offset: Long, val data: ByteArray?, val zero: Long)

  fun parse(json: String): Triple<Pair<File, File>, List<Patch>, Long?> {
    val o = JSONObject(json)
    val arr = o.getJSONArray("patches")
    val patches =
      (0 until arr.length()).map {
        val p = arr.getJSONObject(it)
        val zero = p.optLong("zero", 0)
        Patch(p.getLong("offset"), if (zero > 0) null else Base64.getDecoder().decode(p.getString("dataB64")), zero)
      }
    val truncate = if (o.has("truncate") && !o.isNull("truncate")) o.getLong("truncate") else null
    return Triple(File(o.getString("src")) to File(o.getString("dest")), patches, truncate)
  }

  fun apply(src: File, dest: File, patches: List<Patch>, truncate: Long?) {
    val size = src.length()
    for (p in patches) {
      val len = p.data?.size?.toLong() ?: p.zero
      if (p.offset < 0 || len < 0 || p.offset + len > size) throw IOException("patch outside the file")
    }
    if (truncate != null && (truncate < 0 || truncate > size)) throw IOException("invalid truncate offset")
    if (src.canonicalPath != dest.canonicalPath) src.copyTo(dest, overwrite = true)
    RandomAccessFile(dest, "rw").use { f ->
      val zeros = ByteArray(1 shl 20)
      for (p in patches) {
        f.seek(p.offset)
        if (p.data != null) f.write(p.data)
        else {
          var left = p.zero
          while (left > 0) {
            val n = minOf(left, zeros.size.toLong()).toInt()
            f.write(zeros, 0, n)
            left -= n
          }
        }
      }
      if (truncate != null) f.setLength(truncate)
    }
  }
}
