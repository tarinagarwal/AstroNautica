package org.azaadawaaz.app.core

import okhttp3.Dns
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.net.Proxy
import java.net.UnknownHostException
import java.nio.file.Files
import java.util.Base64
import java.util.concurrent.TimeUnit

class NetCoreTest {
  private lateinit var server: MockWebServer

  @Before fun start() {
    server = MockWebServer()
    server.start(InetAddress.getByName("127.0.0.1"), 0)
  }

  @After fun stop() = server.shutdown()

  private fun url(path: String) = server.url(path).toString()

  @Test fun torModeUsesSocksAndNeverLocalDns() {
    val net = NetCore()
    net.configure("""{"mode":"tor","socksPort":9150,"doh":false}""")
    val c = net.client()
    assertEquals(Proxy.Type.SOCKS, c.proxy!!.type())
    assertEquals(9150, (c.proxy!!.address() as java.net.InetSocketAddress).port)
    try {
      c.dns.lookup("example.org")
      fail("local DNS used in Tor mode")
    } catch (_: UnknownHostException) {}
    net.configure("""{"mode":"direct","doh":true}""")
    assertEquals(null, net.client().proxy)
  }

  @Test fun blockedModeRefusesRequests() {
    val net = NetCore()
    net.configure("""{"mode":"blocked"}""")
    try {
      HttpBridge(net).request("1", JSONObject().put("url", url("/x")).toString())
      fail("request sent while blocked")
    } catch (e: CodedException) {
      assertEquals("network", e.code)
    }
  }

  @Test fun onionNamesNeverReachAResolver() {
    var asked = false
    val dns = NetCore.OnionGuardDns(object : Dns { override fun lookup(hostname: String): List<InetAddress> { asked = true; return listOf(InetAddress.getLoopbackAddress()) } })
    try {
      dns.lookup("abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion")
      fail()
    } catch (_: UnknownHostException) {}
    assertFalse(asked)
  }

  @Test fun chainedDnsTriesResolversInOrder() {
    val a = InetAddress.getByName("192.0.2.1")
    val failing = object : Dns { override fun lookup(hostname: String): List<InetAddress> = throw UnknownHostException("blocked") }
    val ok = object : Dns { override fun lookup(hostname: String): List<InetAddress> = listOf(a) }
    assertEquals(listOf(a), NetCore.ChainedDns(listOf(failing, ok), null).lookup("x.test"))
    try {
      NetCore.ChainedDns(listOf(failing), null).lookup("x.test")
      fail()
    } catch (_: UnknownHostException) {}
  }

  /** A real DNS-over-HTTPS exchange against a local server answering RFC 8484 wire-format queries. */
  @Test fun resolvesThroughDnsOverHttps() {
    server.dispatcher =
      object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
          val q = Base64.getUrlDecoder().decode(request.requestUrl!!.queryParameter("dns")!!)
          return MockResponse().setHeader("content-type", "application/dns-message").setBody(Buffer().write(dnsAnswer(q)))
        }
      }
    val net = NetCore(listOf(NetCore.DohResolver("http://127.0.0.1:${server.port}/dns-query", listOf("127.0.0.1"))))
    val addrs = net.dohDns.lookup("story.example")
    assertEquals(listOf(InetAddress.getByName("203.0.113.7")), addrs.filter { it.address.size == 4 })
  }

  /** Answer A queries with 203.0.113.7 and AAAA queries with no records. */
  private fun dnsAnswer(q: ByteArray): ByteArray {
    var p = 12
    while (q[p].toInt() != 0) p += q[p] + 1
    val qtype = ((q[p + 1].toInt() and 0xff) shl 8) or (q[p + 2].toInt() and 0xff)
    val question = q.copyOfRange(12, p + 5)
    val out = java.io.ByteArrayOutputStream()
    out.write(q, 0, 2)
    out.write(byteArrayOf(0x81.toByte(), 0x80.toByte(), 0, 1, 0, if (qtype == 1) 1 else 0, 0, 0, 0, 0))
    out.write(question)
    if (qtype == 1) out.write(byteArrayOf(0xc0.toByte(), 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 203.toByte(), 0, 113, 7))
    return out.toByteArray()
  }

  @Test fun requestReturnsStatusHeadersAndBody() {
    server.enqueue(MockResponse().setBody("hello").setHeader("X-Test", "1"))
    val net = NetCore().apply { configure("""{"mode":"direct","doh":false}""") }
    val r =
      JSONObject(
        HttpBridge(net).request(
          "a",
          JSONObject().put("url", url("/p")).put("method", "POST").put("headers", JSONObject().put("content-type", "text/plain")).put("bodyBase64", Base64.getEncoder().encodeToString("ping".toByteArray())).toString(),
        ),
      )
    assertEquals(200, r.getInt("status"))
    assertEquals("1", r.getJSONObject("headers").getString("x-test"))
    assertEquals("hello", String(Base64.getDecoder().decode(r.getString("bodyBase64"))))
    val rec = server.takeRequest()
    assertEquals("POST", rec.method)
    assertEquals("ping", rec.body.readUtf8())
  }

  @Test fun requestEnforcesMaxBytes() {
    server.enqueue(MockResponse().setBody("x".repeat(5000)))
    val net = NetCore().apply { configure("""{"mode":"direct","doh":false}""") }
    try {
      HttpBridge(net).request("b", JSONObject().put("url", url("/big")).put("maxBytes", 1000).toString())
      fail()
    } catch (e: CodedException) {
      assertEquals("too-large", e.code)
    }
  }

  @Test fun requestTimesOut() {
    server.enqueue(MockResponse().setBody("late").setHeadersDelay(3, TimeUnit.SECONDS))
    val net = NetCore().apply { configure("""{"mode":"direct","doh":false}""") }
    try {
      HttpBridge(net).request("c", JSONObject().put("url", url("/slow")).put("timeoutMs", 300).toString())
      fail()
    } catch (e: CodedException) {
      assertEquals("timeout", e.code)
    }
  }

  @Test fun downloadVerifiesSha256AndLeavesNothingOnMismatch() {
    val dir = Files.createTempDirectory("dl").toFile()
    val body = ByteArray(700_000) { (it % 251).toByte() }
    val sha = Hashing.sha256Hex(body)
    server.enqueue(MockResponse().setBody(Buffer().write(body)))
    server.enqueue(MockResponse().setBody(Buffer().write(body.copyOf().also { it[10] = 0 })))
    val net = NetCore().apply { configure("""{"mode":"direct","doh":false}""") }
    val http = HttpBridge(net)
    var progressed = 0L
    val dest = File(dir, "f.bin")
    val r = JSONObject(http.download("d", JSONObject().put("url", url("/f")).put("dest", dest.path).put("sha256", sha).toString()) { b, _ -> progressed = b })
    assertEquals(sha, r.getString("sha256"))
    assertEquals(body.size.toLong(), progressed)
    val bad = File(dir, "g.bin")
    try {
      http.download("e", JSONObject().put("url", url("/g")).put("dest", bad.path).put("sha256", sha).toString(), null)
      fail()
    } catch (e: CodedException) {
      assertEquals("mismatch", e.code)
    }
    assertFalse(bad.exists())
    assertFalse(File(dir, "g.bin.part").exists())
  }

  @Test fun uploadSendsTheFile() {
    val f = Files.createTempFile("up", ".bin").toFile().apply { writeBytes(ByteArray(1234) { 7 }) }
    server.enqueue(MockResponse().setBody("{\"ok\":true}"))
    val net = NetCore().apply { configure("""{"mode":"direct","doh":false}""") }
    val r = JSONObject(HttpBridge(net).upload("u", JSONObject().put("url", url("/c/0")).put("method", "PUT").put("headers", JSONObject().put("authorization", "Nostr x")).put("filePath", f.path).toString()))
    assertEquals(200, r.getInt("status"))
    val rec = server.takeRequest()
    assertEquals("PUT", rec.method)
    assertEquals("Nostr x", rec.getHeader("authorization"))
    assertEquals(1234L, rec.bodySize)
  }

  @Test fun cancelAbortsARequest() {
    server.enqueue(MockResponse().setBody("x").setHeadersDelay(5, TimeUnit.SECONDS))
    val net = NetCore().apply { configure("""{"mode":"direct","doh":false}""") }
    val http = HttpBridge(net)
    Thread { Thread.sleep(300); http.cancel("z") }.start()
    try {
      http.request("z", JSONObject().put("url", url("/slow")).put("timeoutMs", 10_000).toString())
      fail()
    } catch (e: CodedException) {
      assertEquals("aborted", e.code)
    }
    assertTrue(true)
  }
}
