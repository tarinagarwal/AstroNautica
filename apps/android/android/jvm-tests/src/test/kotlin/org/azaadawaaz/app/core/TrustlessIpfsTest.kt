package org.azaadawaaz.app.core

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.InetAddress

/** Builds a small UnixFS DAG (raw leaves, a chunked file node and a directory) and serves its blocks from gateways. */
class TrustlessIpfsTest {
  private val blocks = HashMap<String, ByteArray>()
  private lateinit var good: MockWebServer
  private lateinit var evil: MockWebServer

  private fun cidOf(codec: Int, bytes: ByteArray): TrustlessIpfs.Cid {
    val bin = byteArrayOf(1) + TrustlessIpfs.writeVarint(codec.toLong()) + byteArrayOf(0x12, 32) + Hashing.sha256(bytes)
    return TrustlessIpfs.parseCid("b" + TrustlessIpfs.base32Encode(bin))
  }

  private fun field(n: Int, wire: Int) = TrustlessIpfs.writeVarint(((n shl 3) or wire).toLong())
  private fun lenField(n: Int, b: ByteArray) = field(n, 2) + TrustlessIpfs.writeVarint(b.size.toLong()) + b
  private fun varField(n: Int, v: Long) = field(n, 0) + TrustlessIpfs.writeVarint(v)

  private fun cidBytes(c: TrustlessIpfs.Cid) = TrustlessIpfs.base32Decode(c.string.substring(1))

  private fun link(c: TrustlessIpfs.Cid, name: String, size: Long) = lenField(2, lenField(1, cidBytes(c)) + lenField(2, name.toByteArray()) + varField(3, size))

  private fun pbNode(links: List<ByteArray>, unixfs: ByteArray): ByteArray = links.fold(ByteArray(0)) { a, l -> a + l } + lenField(1, unixfs)

  private fun add(codec: Int, bytes: ByteArray): TrustlessIpfs.Cid = cidOf(codec, bytes).also { blocks[it.string] = bytes }

  private lateinit var file: ByteArray
  private lateinit var fileCid: TrustlessIpfs.Cid
  private lateinit var dirCid: TrustlessIpfs.Cid

  @Before fun build() {
    val a = ByteArray(3000) { (it % 200).toByte() }
    val b = ByteArray(1500) { (it % 97).toByte() }
    file = a + b
    val la = add(TrustlessIpfs.CODEC_RAW, a)
    val lb = add(TrustlessIpfs.CODEC_RAW, b)
    fileCid = add(TrustlessIpfs.CODEC_DAG_PB, pbNode(listOf(link(la, "", 3000), link(lb, "", 1500)), varField(1, 2) + varField(3, 4500)))
    val playlist = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n720p/index.m3u8\n".toByteArray()
    val pl = add(TrustlessIpfs.CODEC_RAW, playlist)
    val sub = add(TrustlessIpfs.CODEC_DAG_PB, pbNode(listOf(link(fileCid, "seg0.ts", 4500)), varField(1, 1)))
    dirCid = add(TrustlessIpfs.CODEC_DAG_PB, pbNode(listOf(link(sub, "720p", 4600), link(pl, "master.m3u8", playlist.size.toLong())), varField(1, 1)))
    good = MockWebServer().apply { dispatcher = serve(false); start(InetAddress.getByName("127.0.0.1"), 0) }
    evil = MockWebServer().apply { dispatcher = serve(true); start(InetAddress.getByName("127.0.0.1"), 0) }
  }

  @After fun stop() {
    good.shutdown()
    evil.shutdown()
  }

  private fun serve(corrupt: Boolean) =
    object : Dispatcher() {
      override fun dispatch(request: RecordedRequest): MockResponse {
        val cid = request.requestUrl!!.pathSegments.getOrNull(1) ?: return MockResponse().setResponseCode(404)
        val b = blocks[cid] ?: return MockResponse().setResponseCode(404)
        val body = if (corrupt) b.copyOf().also { it[0] = (it[0].toInt() xor 0xff).toByte() } else b
        return MockResponse().setBody(Buffer().write(body))
      }
    }

  private fun base(s: MockWebServer) = "http://127.0.0.1:${s.port}"

  @Test fun cidRoundTripsAndRejectsOtherHashes() {
    assertEquals(fileCid.string, TrustlessIpfs.parseCid(fileCid.string).string)
    try {
      TrustlessIpfs.parseCid("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku".replace("bafkrei", "bafkqai"))
      fail()
    } catch (_: Exception) {}
  }

  @Test fun streamsAChunkedFileVerifyingEveryBlock() {
    val flagged = mutableListOf<String>()
    val ipfs = TrustlessIpfs({ OkHttpClient() }, { listOf(base(evil), base(good)) }, { flagged.add(it) })
    val out = ByteArrayOutputStream()
    assertEquals(4500L, ipfs.writeFile(fileCid, out))
    assertArrayEquals(file, out.toByteArray())
    assertTrue(flagged.contains(base(evil)))
  }

  @Test fun resolvesHlsPathsThroughVerifiedDirectories() {
    val ipfs = TrustlessIpfs({ OkHttpClient() }, { listOf(base(good)) })
    val out = ByteArrayOutputStream()
    ipfs.writePath("${dirCid.string}/master.m3u8", out)
    assertTrue(String(out.toByteArray()).startsWith("#EXTM3U"))
    val seg = ByteArrayOutputStream()
    ipfs.writePath("${dirCid.string}/720p/seg0.ts", seg)
    assertArrayEquals(file, seg.toByteArray())
  }

  @Test fun failsWhenOnlyBadGatewaysExist() {
    val ipfs = TrustlessIpfs({ OkHttpClient() }, { listOf(base(evil)) })
    try {
      ipfs.writeFile(fileCid, ByteArrayOutputStream())
      fail("served unverified bytes")
    } catch (_: IOException) {}
  }

  @Test fun refusesMissingPaths() {
    val ipfs = TrustlessIpfs({ OkHttpClient() }, { listOf(base(good)) })
    try {
      ipfs.writePath("${dirCid.string}/nope.m3u8", ByteArrayOutputStream())
      fail()
    } catch (_: IOException) {}
  }
}
