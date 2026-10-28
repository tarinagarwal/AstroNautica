package org.azaadawaaz.app.core

import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.io.OutputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * Trustless IPFS reads for streaming playback (same rules as the app's TypeScript reader): raw blocks are fetched
 * from the gateways in order (`?format=raw`), each block must hash to the SHA-256 in its CID, and files and paths are
 * rebuilt from verified dag-pb/UnixFS blocks. A gateway serving wrong bytes is skipped and reported.
 */
class TrustlessIpfs(
  private val client: () -> OkHttpClient,
  private val gateways: () -> List<String>,
  private val onMismatch: (String) -> Unit = {},
) {
  companion object {
    const val CODEC_RAW = 0x55
    const val CODEC_DAG_PB = 0x70
    private const val MH_SHA256 = 0x12
    private const val B32 = "abcdefghijklmnopqrstuvwxyz234567"
    const val UNIXFS_RAW = 0
    const val UNIXFS_DIRECTORY = 1
    const val UNIXFS_FILE = 2
    const val UNIXFS_HAMT = 5

    fun base32Encode(bytes: ByteArray): String {
      val sb = StringBuilder()
      var bits = 0
      var value = 0
      for (b in bytes) {
        value = ((value shl 8) or (b.toInt() and 0xff)) and 0xffff
        bits += 8
        while (bits >= 5) {
          sb.append(B32[(value ushr (bits - 5)) and 31])
          bits -= 5
        }
      }
      if (bits > 0) sb.append(B32[(value shl (5 - bits)) and 31])
      return sb.toString()
    }

    fun base32Decode(s: String): ByteArray {
      val out = java.io.ByteArrayOutputStream()
      var bits = 0
      var value = 0
      for (ch in s) {
        val v = B32.indexOf(ch)
        require(v >= 0) { "invalid base32" }
        value = ((value shl 5) or v) and 0xffff
        bits += 5
        if (bits >= 8) {
          out.write((value ushr (bits - 8)) and 255)
          bits -= 8
        }
      }
      return out.toByteArray()
    }

    fun readVarint(buf: ByteArray, start: Int): Pair<Long, Int> {
      var pos = start
      var value = 0L
      var shift = 0
      while (true) {
        if (pos >= buf.size) throw IOException("truncated varint")
        val b = buf[pos++].toInt() and 0xff
        value = value or ((b and 0x7f).toLong() shl shift)
        if (b < 0x80) return value to pos
        shift += 7
        if (shift > 49) throw IOException("varint too long")
      }
    }

    fun writeVarint(n: Long): ByteArray {
      val out = java.io.ByteArrayOutputStream()
      var v = n
      while (v >= 0x80) {
        out.write(((v and 0x7f) or 0x80).toInt())
        v = v ushr 7
      }
      out.write(v.toInt())
      return out.toByteArray()
    }

    fun parseCid(s: String): Cid {
      require(Regex("^b[a-z2-7]+$").matches(s)) { "unsupported CID: $s" }
      return parseCidBytes(base32Decode(s.substring(1)))
    }

    fun parseCidBytes(b: ByteArray): Cid {
      if (b.size >= 2 && b[0].toInt() == MH_SHA256 && b[1].toInt() == 32) return fromMultihash(CODEC_DAG_PB, b, 0)
      val (version, p1) = readVarint(b, 0)
      if (version != 1L) throw IOException("unsupported CID version")
      val (codec, p2) = readVarint(b, p1)
      if (codec.toInt() != CODEC_RAW && codec.toInt() != CODEC_DAG_PB) throw IOException("unsupported codec 0x${codec.toString(16)}")
      return fromMultihash(codec.toInt(), b, p2)
    }

    private fun fromMultihash(codec: Int, mh: ByteArray, at: Int): Cid {
      val (code, p1) = readVarint(mh, at)
      val (len, p2) = readVarint(mh, p1)
      if (code.toInt() != MH_SHA256 || len != 32L) throw IOException("only sha2-256 CIDs are supported")
      if (p2 + 32 > mh.size) throw IOException("truncated multihash")
      val digest = mh.copyOfRange(p2, p2 + 32)
      val bin = byteArrayOf(1) + writeVarint(codec.toLong()) + byteArrayOf(MH_SHA256.toByte(), 32) + digest
      return Cid(codec, digest, "b" + base32Encode(bin))
    }
  }

  data class Cid(val codec: Int, val digest: ByteArray, val string: String) {
    override fun equals(other: Any?) = other is Cid && other.string == string
    override fun hashCode() = string.hashCode()
  }

  data class Link(val cid: Cid, val name: String, val size: Long)

  class Node(val links: List<Link>, val data: ByteArray?)

  class UnixFs(val type: Int, val data: ByteArray?)

  private fun fields(buf: ByteArray, each: (field: Int, wire: Int, varint: Long, bytes: ByteArray?) -> Unit) {
    var pos = 0
    while (pos < buf.size) {
      val (key, p) = readVarint(buf, pos)
      pos = p
      val field = (key ushr 3).toInt()
      when (val wire = (key and 7).toInt()) {
        0 -> {
          val (v, p2) = readVarint(buf, pos)
          pos = p2
          each(field, wire, v, null)
        }
        2 -> {
          val (len, p2) = readVarint(buf, pos)
          if (p2 + len > buf.size) throw IOException("truncated protobuf field")
          each(field, wire, 0, buf.copyOfRange(p2, (p2 + len).toInt()))
          pos = (p2 + len).toInt()
        }
        1 -> pos += 8
        5 -> pos += 4
        else -> throw IOException("unsupported protobuf wire type $wire")
      }
    }
  }

  fun decodeNode(bytes: ByteArray): Node {
    val links = ArrayList<Link>()
    var data: ByteArray? = null
    fields(bytes) { field, wire, _, b ->
      if (field == 1 && wire == 2) data = b
      if (field == 2 && wire == 2) {
        var cid: Cid? = null
        var name = ""
        var size = 0L
        fields(b!!) { f2, w2, v2, b2 ->
          if (f2 == 1 && w2 == 2) cid = parseCidBytes(b2!!)
          if (f2 == 2 && w2 == 2) name = String(b2!!, Charsets.UTF_8)
          if (f2 == 3 && w2 == 0) size = v2
        }
        links.add(Link(cid ?: throw IOException("dag-pb link without a hash"), name, size))
      }
    }
    return Node(links, data)
  }

  fun decodeUnixFs(bytes: ByteArray?): UnixFs {
    if (bytes == null) throw IOException("dag-pb node without UnixFS data")
    var type = -1
    var data: ByteArray? = null
    fields(bytes) { field, wire, v, b ->
      if (field == 1 && wire == 0) type = v.toInt()
      if (field == 2 && wire == 2) data = b
    }
    return UnixFs(type, data)
  }

  private val cache = object : LinkedHashMap<String, ByteArray>(64, 0.75f, true) {
    var bytes = 0L
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, ByteArray>?): Boolean {
      if (bytes > 32L * 1024 * 1024 && eldest != null) {
        bytes -= eldest.value.size
        return true
      }
      return false
    }
  }

  /** One verified block, trying each gateway in turn. */
  fun block(cid: Cid): ByteArray {
    synchronized(cache) { cache[cid.string]?.let { return it } }
    val c = client().newBuilder().callTimeout(30, TimeUnit.SECONDS).build()
    var last: Exception? = null
    for (base in gateways()) {
      val url = "${base.trimEnd('/')}/ipfs/${cid.string}?format=raw"
      try {
        c.newCall(Request.Builder().url(url).header("Accept", "application/vnd.ipld.raw").build()).execute().use { res ->
          if (!res.isSuccessful) throw IOException("HTTP ${res.code} from $base")
          val body = res.body?.bytes() ?: throw IOException("empty body from $base")
          if (body.size > 4 * 1024 * 1024) throw IOException("block too large from $base")
          if (!MessageDigest.isEqual(MessageDigest.getInstance("SHA-256").digest(body), cid.digest)) {
            onMismatch(base)
            throw IOException("block mismatch from $base")
          }
          synchronized(cache) {
            cache[cid.string] = body
            cache.bytes += body.size
          }
          return body
        }
      } catch (e: Exception) {
        last = e
      }
    }
    throw IOException("no gateway served a verified block for ${cid.string}", last)
  }

  /** Resolve `root/path/to/file` through verified directory blocks (plain directories and HAMT shards). */
  fun resolve(root: Cid, path: String): Cid {
    var cur = root
    for (segment in path.split('/').filter { it.isNotEmpty() }) {
      val name = java.net.URLDecoder.decode(segment, "UTF-8")
      if (cur.codec != CODEC_DAG_PB) throw IOException("cannot descend into a raw block for \"$name\"")
      cur = findInDirectory(cur, name) ?: throw IOException("\"$name\" not found")
    }
    return cur
  }

  private fun findInDirectory(dir: Cid, name: String): Cid? {
    val node = decodeNode(block(dir))
    val fs = decodeUnixFs(node.data)
    return when (fs.type) {
      UNIXFS_DIRECTORY -> node.links.firstOrNull { it.name == name }?.cid
      UNIXFS_HAMT -> {
        node.links.firstOrNull { it.name.length > 2 && it.name.substring(2) == name }?.cid
          ?: node.links.filter { it.name.length == 2 }.firstNotNullOfOrNull { findInDirectory(it.cid, name) }
      }
      else -> throw IOException("${dir.string} is not a directory")
    }
  }

  /** Stream a file's verified bytes in order to `out`. Returns the number of bytes written. */
  fun writeFile(cid: Cid, out: OutputStream, maxBytes: Long = 4L * 1024 * 1024 * 1024): Long {
    var total = 0L
    fun walk(c: Cid) {
      val b = block(c)
      if (c.codec == CODEC_RAW) {
        total += b.size
        if (total > maxBytes) throw IOException("file too large")
        out.write(b)
        return
      }
      val node = decodeNode(b)
      val fs = decodeUnixFs(node.data)
      if (fs.type != UNIXFS_FILE && fs.type != UNIXFS_RAW) throw IOException("${c.string} is not a file")
      fs.data?.let {
        if (it.isNotEmpty()) {
          total += it.size
          if (total > maxBytes) throw IOException("file too large")
          out.write(it)
        }
      }
      for (l in node.links) walk(l.cid)
    }
    walk(cid)
    out.flush()
    return total
  }

  /** `cid` or `cid/path`, as used by the manifest's HLS field. */
  fun writePath(ipfsPath: String, out: OutputStream): Long {
    val parts = ipfsPath.removePrefix("/").removePrefix("ipfs/").split('/')
    val root = parseCid(parts[0])
    val target = if (parts.size > 1) resolve(root, parts.drop(1).joinToString("/")) else root
    return writeFile(target, out)
  }
}
