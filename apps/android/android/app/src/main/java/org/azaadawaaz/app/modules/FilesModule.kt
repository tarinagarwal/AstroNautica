package org.azaadawaaz.app.modules

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.view.WindowManager
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UiThreadUtil
import org.azaadawaaz.app.Shared
import org.azaadawaaz.app.ShareUris
import org.azaadawaaz.app.core.BundleZip
import org.azaadawaaz.app.core.CodedException
import org.azaadawaaz.app.core.FilePatcher
import org.azaadawaaz.app.core.Hashing
import org.azaadawaaz.app.specs.NativeAzaadFilesSpec
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.util.Base64

/**
 * App-private files for the JS side. Paths must stay inside the app's own directories; anything else is refused.
 */
class FilesModule(ctx: ReactApplicationContext) : NativeAzaadFilesSpec(ctx), ActivityEventListener {
  companion object {
    private const val REQ_PICK = 4101
    private const val REQ_SAVE = 4102
    private const val MAX_IMAGE_EDGE = 4096
  }

  private var pickPromise: Promise? = null
  private var savePromise: Promise? = null
  private var savePath: File? = null

  init {
    ctx.addActivityEventListener(this)
    Shared.onIntent = { reactApplicationContext.emitDeviceEvent("azaadIntent", null) }
  }

  private val roots get() = listOf(reactApplicationContext.filesDir.canonicalFile, reactApplicationContext.cacheDir.canonicalFile)

  /** Resolve a path and refuse anything outside the app's files and cache directories. */
  private fun file(path: String): File {
    val f = File(path).canonicalFile
    if (roots.none { f.path == it.path || f.path.startsWith(it.path + File.separator) }) throw CodedException("forbidden", "path outside app storage")
    return f
  }

  override fun paths(): String =
    JSONObject().put("files", reactApplicationContext.filesDir.absolutePath).put("cache", reactApplicationContext.cacheDir.absolutePath).toString()

  override fun writeBase64(path: String, dataB64: String, append: Boolean, promise: Promise) =
    promise.runIo {
      val f = file(path)
      f.parentFile?.mkdirs()
      val bytes = Base64.getDecoder().decode(dataB64)
      if (append) f.appendBytes(bytes) else f.writeBytes(bytes)
    }

  override fun readBase64(path: String, offset: Double, length: Double, promise: Promise) =
    promise.runIo {
      val f = file(path)
      if (!f.isFile) throw CodedException("not-found", "no such file")
      RandomAccessFile(f, "r").use { raf ->
        val off = offset.toLong().coerceIn(0, raf.length())
        val len = if (length < 0) raf.length() - off else minOf(length.toLong(), raf.length() - off)
        if (len > 64L * 1024 * 1024) throw CodedException("too-large", "read at most 64 MiB at once")
        val buf = ByteArray(len.toInt())
        raf.seek(off)
        raf.readFully(buf)
        Base64.getEncoder().encodeToString(buf)
      }
    }

  override fun writeText(path: String, text: String, promise: Promise) =
    promise.runIo {
      val f = file(path)
      f.parentFile?.mkdirs()
      f.writeText(text)
    }

  override fun readText(path: String, promise: Promise) =
    promise.runIo {
      val f = file(path)
      if (!f.isFile) throw CodedException("not-found", "no such file")
      f.readText()
    }

  override fun stat(path: String, promise: Promise) =
    promise.runIo {
      val f = file(path)
      JSONObject().put("exists", f.exists()).put("size", if (f.isFile) f.length() else 0).put("isDir", f.isDirectory).put("mtime", f.lastModified()).toString()
    }

  override fun remove(path: String, promise: Promise) = promise.runIo { file(path).deleteRecursively() }

  override fun mkdirs(path: String, promise: Promise) = promise.runIo { file(path).mkdirs() }

  override fun list(path: String, promise: Promise) =
    promise.runIo { JSONArray((file(path).list() ?: emptyArray()).sorted()).toString() }

  override fun move(from: String, to: String, promise: Promise) =
    promise.runIo {
      val a = file(from)
      val b = file(to)
      b.parentFile?.mkdirs()
      if (b.exists()) b.deleteRecursively()
      if (!a.renameTo(b)) {
        a.copyRecursively(b, overwrite = true)
        a.deleteRecursively()
      }
    }

  override fun copy(from: String, to: String, promise: Promise) =
    promise.runIo {
      val b = file(to)
      b.parentFile?.mkdirs()
      file(from).copyTo(b, overwrite = true)
    }

  override fun sha256File(path: String, promise: Promise) = promise.runIo { Hashing.sha256Hex(file(path)) }

  override fun patchFile(requestJson: String, promise: Promise) =
    promise.runIo {
      val (files, patches, truncate) = FilePatcher.parse(requestJson)
      FilePatcher.apply(file(files.first.path), file(files.second.path), patches, truncate)
    }

  override fun zipDir(dir: String, out: String, promise: Promise) = promise.runIo { BundleZip.zipDir(file(dir), file(out)) }

  override fun unzip(zipPath: String, destDir: String, maxBytes: Double, maxEntries: Double, promise: Promise) =
    promise.runIo {
      val entries = BundleZip.unzip(file(zipPath), file(destDir), maxBytes.toLong(), maxEntries.toInt())
      val arr = JSONArray()
      entries.forEach { arr.put(JSONObject().put("name", it.name).put("size", it.size)) }
      JSONObject().put("entries", arr).toString()
    }

  private fun displayName(uri: Uri): Pair<String, Long> {
    var name = uri.lastPathSegment ?: "file"
    var size = -1L
    if (uri.scheme == "content") {
      reactApplicationContext.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
          c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { name = c.getString(it) ?: name }
          c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !c.isNull(it) }?.let { size = c.getLong(it) }
        }
      }
    }
    return name to size
  }

  override fun importUri(uri: String, destPath: String, maxBytes: Double, promise: Promise) =
    promise.runIo {
      val u = Uri.parse(uri)
      val dest = file(destPath)
      dest.parentFile?.mkdirs()
      val input =
        when (u.scheme) {
          "content" -> reactApplicationContext.contentResolver.openInputStream(u)
          "file" -> file(u.path ?: "").inputStream()
          else -> throw CodedException("forbidden", "unsupported URI")
        } ?: throw IOException("cannot open $uri")
      var total = 0L
      input.use { src ->
        dest.outputStream().use { out ->
          val buf = ByteArray(1 shl 20)
          while (true) {
            val n = src.read(buf)
            if (n < 0) break
            total += n
            if (total > maxBytes.toLong()) {
              dest.delete()
              throw CodedException("too-large", "file is too large")
            }
            out.write(buf, 0, n)
          }
        }
      }
      val (name, _) = displayName(u)
      JSONObject().put("size", total).put("name", name).put("mime", reactApplicationContext.contentResolver.getType(u) ?: "").toString()
    }

  override fun pickDocuments(mimeTypesJson: String, multiple: Boolean, promise: Promise) {
    val activity = reactApplicationContext.currentActivity ?: return promise.reject("no-activity", "no activity")
    val arr = JSONArray(mimeTypesJson)
    val types = (0 until arr.length()).map { arr.getString(it) }.toTypedArray()
    val intent =
      Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = if (types.size == 1) types[0] else "*/*"
        if (types.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, types)
        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
      }
    pickPromise?.resolve("[]")
    pickPromise = promise
    activity.startActivityForResult(intent, REQ_PICK)
  }

  override fun shareFile(path: String, mime: String, title: String, promise: Promise) {
    try {
      val f = file(path)
      val uri = ShareUris.forFile(reactApplicationContext, f)
      val send =
        Intent(Intent.ACTION_SEND).apply {
          type = mime
          putExtra(Intent.EXTRA_STREAM, uri)
          clipData = ClipData.newRawUri(f.name, uri)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
      val chooser = Intent.createChooser(send, title).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
      (reactApplicationContext.currentActivity ?: reactApplicationContext).startActivity(chooser)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("error", e.message, e)
    }
  }

  override fun saveAs(path: String, suggestedName: String, mime: String, promise: Promise) {
    val activity = reactApplicationContext.currentActivity ?: return promise.reject("no-activity", "no activity")
    savePath = file(path)
    savePromise?.resolve(false)
    savePromise = promise
    activity.startActivityForResult(
      Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = mime
        putExtra(Intent.EXTRA_TITLE, suggestedName)
      },
      REQ_SAVE,
    )
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    when (requestCode) {
      REQ_PICK -> {
        val p = pickPromise ?: return
        pickPromise = null
        if (resultCode != Activity.RESULT_OK || data == null) return p.resolve("[]")
        val uris = mutableListOf<Uri>()
        data.clipData?.let { clip -> for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri) } ?: data.data?.let { uris.add(it) }
        Shared.io.execute {
          val arr = JSONArray()
          uris.forEach { u ->
            val (name, size) = displayName(u)
            arr.put(JSONObject().put("uri", u.toString()).put("name", name).put("size", size).put("mime", reactApplicationContext.contentResolver.getType(u) ?: ""))
          }
          p.resolve(arr.toString())
        }
      }
      REQ_SAVE -> {
        val p = savePromise ?: return
        val src = savePath
        savePromise = null
        val uri = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null || src == null) return p.resolve(false)
        Shared.io.execute {
          try {
            reactApplicationContext.contentResolver.openOutputStream(uri, "w")?.use { out -> src.inputStream().use { it.copyTo(out, 1 shl 20) } }
              ?: throw IOException("cannot write to the chosen location")
            p.resolve(true)
          } catch (e: Exception) {
            p.reject("error", e.message, e)
          }
        }
      }
    }
  }

  override fun onNewIntent(intent: Intent) {}

  /**
   * Decode (JPEG, PNG, WebP, HEIC/HEIF, AVIF where supported), apply the orientation, downscale to at most 4096 px
   * and write a JPEG with Bitmap.compress, which writes no metadata and uses the platform's quantisation tables.
   */
  override fun imageToJpeg(src: String, dest: String, quality: Double, promise: Promise) =
    promise.runIo {
      val inFile = file(src)
      val outFile = file(dest)
      val bitmap: Bitmap =
        if (Build.VERSION.SDK_INT >= 28) {
          ImageDecoder.decodeBitmap(ImageDecoder.createSource(inFile)) { decoder, info, _ ->
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            val w = info.size.width
            val h = info.size.height
            val scale = minOf(1.0, MAX_IMAGE_EDGE.toDouble() / maxOf(w, h))
            if (scale < 1.0) decoder.setTargetSize(maxOf(1, (w * scale).toInt()), maxOf(1, (h * scale).toInt()))
          }
        } else {
          val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
          BitmapFactory.decodeFile(inFile.path, bounds)
          var sample = 1
          while (maxOf(bounds.outWidth, bounds.outHeight) / sample > MAX_IMAGE_EDGE) sample *= 2
          val raw = BitmapFactory.decodeFile(inFile.path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: throw IOException("cannot decode image")
          val orientation = ExifInterface(inFile.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
          val m = Matrix()
          when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.postScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { m.postRotate(90f); m.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_TRANSVERSE -> { m.postRotate(270f); m.postScale(-1f, 1f) }
          }
          if (m.isIdentity) raw else Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, m, true).also { if (it !== raw) raw.recycle() }
        }
      try {
        outFile.parentFile?.mkdirs()
        outFile.outputStream().use { out ->
          if (!bitmap.compress(Bitmap.CompressFormat.JPEG, quality.toInt().coerceIn(50, 100), out)) throw IOException("JPEG encoding failed")
        }
        JSONObject().put("width", bitmap.width).put("height", bitmap.height).toString()
      } finally {
        bitmap.recycle()
      }
    }

  override fun takePendingIntent(promise: Promise) {
    val p = Shared.pendingIntent
    Shared.pendingIntent = null
    promise.resolve(p?.let { JSONObject(it as Map<*, *>).toString() })
  }

  override fun setSecureScreen(on: Boolean) {
    UiThreadUtil.runOnUiThread {
      val w = reactApplicationContext.currentActivity?.window ?: return@runOnUiThread
      if (on) w.addFlags(WindowManager.LayoutParams.FLAG_SECURE) else w.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }
  }

  override fun addListener(eventName: String) {}

  override fun removeListeners(count: Double) {}
}
