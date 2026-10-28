package org.azaadawaaz.app.core

import okhttp3.Call
import okhttp3.Headers
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InterruptedIOException
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Executes the JS side's HTTP requests on the shared client: in-memory requests (bodies as base64), streaming
 * downloads to files with SHA-256 verification, and uploads straight from files. Every call can be cancelled by id.
 */
class HttpBridge(private val net: NetCore) {
  private val calls = ConcurrentHashMap<String, Call>()
  private val cancelled = ConcurrentHashMap.newKeySet<String>()

  fun cancel(id: String) {
    cancelled.add(id)
    calls.remove(id)?.cancel()
  }

  /** `callTimeoutMs` bounds the whole call (0 = none); `idleTimeoutMs` bounds each read and write. */
  private fun newCall(id: String, req: Request, callTimeoutMs: Long, idleTimeoutMs: Long = 60_000): Call {
    net.blockedReason()?.let { throw CodedException("network", it) }
    if (cancelled.remove(id)) throw CodedException("aborted", "aborted")
    val client =
      net.client().newBuilder()
        .callTimeout(callTimeoutMs, TimeUnit.MILLISECONDS)
        .readTimeout(idleTimeoutMs, TimeUnit.MILLISECONDS)
        .writeTimeout(idleTimeoutMs, TimeUnit.MILLISECONDS)
        .build()
    return client.newCall(req).also { calls[id] = it }
  }

  private fun headersOf(o: JSONObject?): Headers {
    val b = Headers.Builder()
    o?.keys()?.forEach { k -> b.add(k, o.getString(k)) }
    return b.build()
  }

  private fun mapError(id: String, e: Throwable): CodedException =
    when {
      e is CodedException -> e
      cancelled.remove(id) -> CodedException("aborted", "aborted", e)
      e is InterruptedIOException -> CodedException("timeout", e.message ?: "timeout", e)
      else -> CodedException("network", e.message ?: e.javaClass.simpleName, e)
    }

  private fun responseJson(res: Response, body: ByteArray?): String {
    val headers = JSONObject()
    for ((name, value) in res.headers) headers.put(name.lowercase(), value)
    return JSONObject()
      .put("status", res.code)
      .put("headers", headers)
      .put("url", res.request.url.toString())
      .apply { if (body != null) put("bodyBase64", Base64.getEncoder().encodeToString(body)) }
      .toString()
  }

  /** `{"url","method","headers","bodyBase64"?,"timeoutMs","maxBytes"}` → `{"status","headers","bodyBase64","url"}` */
  fun request(id: String, json: String): String {
    val o = JSONObject(json)
    val method = o.optString("method", "GET").uppercase()
    val headers = headersOf(o.optJSONObject("headers"))
    val body: RequestBody? =
      if (o.has("bodyBase64") && !o.isNull("bodyBase64")) {
        Base64.getDecoder().decode(o.getString("bodyBase64")).toRequestBody(headers["content-type"]?.toMediaTypeOrNull())
      } else if (method == "POST" || method == "PUT" || method == "PATCH") ByteArray(0).toRequestBody(null) else null
    val maxBytes = o.optLong("maxBytes", 50L * 1024 * 1024)
    val req = Request.Builder().url(o.getString("url")).headers(headers).method(method, body).build()
    try {
      val timeout = o.optLong("timeoutMs", 30_000)
      newCall(id, req, timeout, timeout).execute().use { res ->
        val declared = res.body?.contentLength() ?: -1
        if (declared > maxBytes) throw CodedException("too-large", "response larger than $maxBytes bytes")
        val bytes = readLimited(res, maxBytes)
        return responseJson(res, bytes)
      }
    } catch (e: Throwable) {
      throw mapError(id, e)
    } finally {
      calls.remove(id)
    }
  }

  private fun readLimited(res: Response, maxBytes: Long): ByteArray {
    val src = res.body?.byteStream() ?: return ByteArray(0)
    val out = java.io.ByteArrayOutputStream()
    val buf = ByteArray(64 * 1024)
    var total = 0L
    while (true) {
      val n = src.read(buf)
      if (n < 0) break
      total += n
      if (total > maxBytes) throw CodedException("too-large", "response larger than $maxBytes bytes")
      out.write(buf, 0, n)
    }
    return out.toByteArray()
  }

  fun interface Progress {
    fun onProgress(bytes: Long, total: Long)
  }

  /**
   * `{"url","dest","headers"?,"sha256"?,"maxBytes","timeoutMs"}` → `{"sha256","size"}`. Writes to a temporary file
   * and moves it into place only if the status is 2xx, the size is within the limit and (when given) the SHA-256
   * matches; otherwise nothing is left behind.
   */
  fun download(id: String, json: String, progress: Progress?): String {
    val o = JSONObject(json)
    val dest = File(o.getString("dest"))
    val expected = o.optString("sha256", "").lowercase().ifEmpty { null }
    val maxBytes = o.optLong("maxBytes", Long.MAX_VALUE)
    val req = Request.Builder().url(o.getString("url")).headers(headersOf(o.optJSONObject("headers"))).get().build()
    val tmp = File(dest.parentFile, dest.name + ".part")
    try {
      dest.parentFile?.mkdirs()
      newCall(id, req, 0, o.optLong("timeoutMs", 60_000)).execute().use { res ->
        if (!res.isSuccessful) throw CodedException("network", "HTTP ${res.code}")
        val body = res.body ?: throw CodedException("network", "empty response")
        val total = body.contentLength()
        if (total > maxBytes) throw CodedException("too-large", "file larger than $maxBytes bytes")
        val md = MessageDigest.getInstance("SHA-256")
        var count = 0L
        var lastReport = 0L
        tmp.outputStream().use { out ->
          val src = body.byteStream()
          val buf = ByteArray(256 * 1024)
          while (true) {
            val n = src.read(buf)
            if (n < 0) break
            count += n
            if (count > maxBytes) throw CodedException("too-large", "file larger than $maxBytes bytes")
            md.update(buf, 0, n)
            out.write(buf, 0, n)
            if (progress != null && count - lastReport >= 512 * 1024) {
              lastReport = count
              progress.onProgress(count, total)
            }
          }
        }
        val sha = Hex.encode(md.digest())
        if (expected != null && !Hashing.hexEquals(sha, expected)) throw CodedException("mismatch", "downloaded bytes do not match sha256 $expected")
        if (dest.exists()) dest.delete()
        if (!tmp.renameTo(dest)) throw IOException("cannot move download into place")
        progress?.onProgress(count, total)
        return JSONObject().put("sha256", sha).put("size", count).toString()
      }
    } catch (e: Throwable) {
      tmp.delete()
      throw mapError(id, e)
    } finally {
      calls.remove(id)
    }
  }

  /** `{"url","method","headers","filePath"}` → response JSON (body included, at most 4 MiB). */
  fun upload(id: String, json: String): String {
    val o = JSONObject(json)
    val headers = headersOf(o.optJSONObject("headers"))
    val file = File(o.getString("filePath"))
    if (!file.isFile) throw CodedException("network", "file not found: ${file.name}")
    val body = file.asRequestBody(headers["content-type"]?.toMediaTypeOrNull())
    val req = Request.Builder().url(o.getString("url")).headers(headers).method(o.optString("method", "PUT").uppercase(), body).build()
    try {
      newCall(id, req, 0, 120_000).execute().use { res -> return responseJson(res, readLimited(res, 4L * 1024 * 1024)) }
    } catch (e: Throwable) {
      throw mapError(id, e)
    } finally {
      calls.remove(id)
    }
  }
}
