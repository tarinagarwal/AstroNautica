package org.azaadawaaz.app.core

import java.io.File
import java.io.IOException
import java.util.zip.Deflater
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

/**
 * Zip container for offline story bundles. Unpacking treats the archive as hostile: entry names may not escape the
 * destination (no absolute paths, "..", backslashes or NUL), duplicates are refused, and the total size and entry
 * count are bounded while reading (declared sizes are not trusted). What the files mean is checked in TypeScript.
 */
object BundleZip {
  data class Entry(val name: String, val size: Long)

  fun zipDir(dir: File, out: File) {
    require(dir.isDirectory) { "not a directory: $dir" }
    out.parentFile?.mkdirs()
    val base = dir.canonicalFile
    ZipOutputStream(out.outputStream().buffered(1 shl 20)).use { zip ->
      zip.setLevel(Deflater.BEST_SPEED)
      base.walkTopDown().filter { it.isFile }.sortedBy { it.relativeTo(base).invariantSeparatorsPath }.forEach { f ->
        zip.putNextEntry(ZipEntry(f.relativeTo(base).invariantSeparatorsPath).apply { time = 0 })
        f.inputStream().use { it.copyTo(zip, 1 shl 20) }
        zip.closeEntry()
      }
    }
  }

  fun safeName(name: String): Boolean =
    name.isNotEmpty() &&
      name.length <= 512 &&
      !name.startsWith("/") &&
      !name.contains('\\') &&
      !name.contains('\u0000') &&
      !Regex("^[A-Za-z]:").containsMatchIn(name) &&
      name.split('/').none { it == ".." || it == "." }

  fun unzip(zip: File, destDir: File, maxBytes: Long, maxEntries: Int): List<Entry> {
    destDir.mkdirs()
    val root = destDir.canonicalFile
    val seen = HashSet<String>()
    val entries = ArrayList<Entry>()
    var total = 0L
    try {
      ZipInputStream(zip.inputStream().buffered(1 shl 20)).use { zin ->
        val buf = ByteArray(1 shl 20)
        while (true) {
          val e = zin.nextEntry ?: break
          val name = e.name
          if (!safeName(name)) throw IOException("unsafe entry name: $name")
          if (!seen.add(name.trimEnd('/'))) throw IOException("duplicate entry: $name")
          if (seen.size > maxEntries) throw IOException("too many entries")
          val target = File(root, name).canonicalFile
          if (!target.path.startsWith(root.path + File.separator)) throw IOException("entry escapes the destination: $name")
          if (e.isDirectory) {
            target.mkdirs()
            entries.add(Entry(name, 0))
            continue
          }
          target.parentFile?.mkdirs()
          var size = 0L
          target.outputStream().use { out ->
            while (true) {
              val n = zin.read(buf)
              if (n < 0) break
              size += n
              total += n
              if (total > maxBytes) throw IOException("bundle larger than $maxBytes bytes")
              out.write(buf, 0, n)
            }
          }
          entries.add(Entry(name, size))
        }
      }
    } catch (e: Exception) {
      destDir.deleteRecursively()
      throw if (e is IOException) e else IOException(e.message, e)
    }
    return entries
  }
}
