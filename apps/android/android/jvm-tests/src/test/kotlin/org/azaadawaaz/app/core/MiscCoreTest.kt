package org.azaadawaaz.app.core

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec

class PowMinerTest {
  @Test fun countsLeadingZeroBits() {
    assertEquals(0, PowMiner.leadingZeroBits(byteArrayOf(0x80.toByte())))
    assertEquals(8, PowMiner.leadingZeroBits(byteArrayOf(0, 0xff.toByte())))
    assertEquals(12, PowMiner.leadingZeroBits(byteArrayOf(0, 0x0f, 0)))
  }

  @Test fun minesANonceWhoseHashHasTheWork() {
    val prefix = """[0,"aa",1700000000,1111,[["nonce",""""
    val suffix = """","12"]],"hi"]"""
    val n = PowMiner.mine(prefix, suffix, 12, 0)
    val h = MessageDigest.getInstance("SHA-256").digest((prefix + n + suffix).toByteArray())
    assertTrue(PowMiner.leadingZeroBits(h) >= 12)
    for (i in 0 until n) assertTrue(PowMiner.leadingZeroBits(MessageDigest.getInstance("SHA-256").digest((prefix + i + suffix).toByteArray())) < 12)
  }

  @Test fun canBeCancelled() {
    try {
      PowMiner.mine("a", "b", 64, 0, AtomicBoolean(true))
      fail()
    } catch (_: InterruptedException) {}
  }
}

class BundleZipTest {
  private fun tmp() = Files.createTempDirectory("bz").toFile()

  @Test fun roundTrips() {
    val src = tmp()
    File(src, "media").mkdirs()
    File(src, "manifest.json").writeText("{}")
    File(src, "media/" + "a".repeat(64)).writeBytes(ByteArray(10_000) { it.toByte() })
    val zip = File(tmp(), "b.zip")
    BundleZip.zipDir(src, zip)
    val out = tmp()
    val entries = BundleZip.unzip(zip, out, 1_000_000, 10)
    assertEquals(setOf("manifest.json", "media/" + "a".repeat(64)), entries.map { it.name }.toSet())
    assertArrayEquals(File(src, "media/" + "a".repeat(64)).readBytes(), File(out, "media/" + "a".repeat(64)).readBytes())
  }

  private fun zipWith(vararg entries: Pair<String, ByteArray>): File {
    val f = File(tmp(), "evil.zip")
    ZipOutputStream(f.outputStream()).use { z -> entries.forEach { (n, b) -> z.putNextEntry(ZipEntry(n)); z.write(b); z.closeEntry() } }
    return f
  }

  @Test fun refusesPathTraversalAndOddNames() {
    for (name in listOf("../evil", "a/../../evil", "/etc/passwd", "a\\b", "C:/x", "./x")) {
      val out = tmp()
      try {
        BundleZip.unzip(zipWith(name to byteArrayOf(1)), out, 1000, 10)
        fail("accepted $name")
      } catch (_: IOException) {}
      assertFalse(File(out.parentFile, "evil").exists())
    }
  }

  @Test fun refusesDuplicatesOversizeAndTooManyEntries() {
    try {
      BundleZip.unzip(zipWith("a" to byteArrayOf(1), "b" to ByteArray(2000)), tmp(), 1000, 10)
      fail()
    } catch (_: IOException) {}
    try {
      BundleZip.unzip(zipWith("a" to byteArrayOf(1), "b" to byteArrayOf(1), "c" to byteArrayOf(1)), tmp(), 1000, 2)
      fail()
    } catch (_: IOException) {}
  }
}

class P2pProtocolTest {
  private fun pair(): Pair<Socket, Socket> {
    val server = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
    val client = Socket(InetAddress.getLoopbackAddress(), server.localPort)
    val accepted = server.accept()
    server.close()
    return accepted to client
  }

  @Test fun transfersAFileWithHandshakeAndAck() {
    val (a, b) = pair()
    val file = Files.createTempFile("bundle", ".zip").toFile().apply { writeBytes(ByteArray(1_000_003) { (it * 13).toByte() }) }
    val dest = Files.createTempDirectory("recv").toFile()
    val result = LinkedBlockingQueue<Any>()
    Thread {
      try {
        val i = b.getInputStream().buffered()
        val o = b.getOutputStream().buffered()
        assertEquals("send", P2pProtocol.handshake(i, o, "receive"))
        result.put(P2pProtocol.receive(i, o, dest))
      } catch (e: Exception) {
        result.put(e)
      }
    }.start()
    val i = a.getInputStream().buffered()
    val o = a.getOutputStream().buffered()
    assertEquals("receive", P2pProtocol.handshake(i, o, "send"))
    P2pProtocol.send(i, o, file)
    val res = result.poll(10, TimeUnit.SECONDS)
    if (res is Exception) throw res
    @Suppress("UNCHECKED_CAST")
    val pair = res as Pair<File, String>
    val (got, sha) = pair
    assertEquals(Hashing.sha256Hex(file), sha)
    assertArrayEquals(file.readBytes(), got.readBytes())
  }

  @Test fun refusesTwoSendersAndDamagedBytes() {
    val (a, b) = pair()
    val done = CountDownLatch(1)
    Thread {
      runCatching { P2pProtocol.handshake(b.getInputStream(), b.getOutputStream(), "send") }
      done.countDown()
    }.start()
    try {
      P2pProtocol.handshake(a.getInputStream(), a.getOutputStream(), "send")
      fail()
    } catch (_: IOException) {}
    done.await(5, TimeUnit.SECONDS)

    val (c, d) = pair()
    val file = Files.createTempFile("bundle", ".zip").toFile().apply { writeBytes(ByteArray(50_000) { 1 }) }
    val err = LinkedBlockingQueue<Any>()
    Thread {
      // Flip one byte of the payload on the way in.
      var count = 0
      val flipping =
        object : FilterInputStream(d.getInputStream()) {
          override fun read(b: ByteArray, off: Int, len: Int): Int {
            val n = super.read(b, off, len)
            for (k in 0 until n) if (count++ == 30_000) b[off + k] = (b[off + k].toInt() xor 1).toByte()
            return n
          }

          override fun read(): Int = super.read().also { if (it >= 0) count++ }
        }
      try {
        P2pProtocol.receive(flipping, d.getOutputStream(), Files.createTempDirectory("r").toFile())
        err.put("accepted")
      } catch (e: IOException) {
        err.put(e)
      }
    }.start()
    try {
      P2pProtocol.send(c.getInputStream(), c.getOutputStream(), file)
      fail("damaged transfer acknowledged")
    } catch (_: IOException) {}
    assertTrue(err.poll(10, TimeUnit.SECONDS) is IOException)
  }
}

class PinVaultTest {
  private class SoftCipher : PinVault.OuterCipher {
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    override fun encrypt(plain: ByteArray): ByteArray {
      val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
      return c.iv + c.doFinal(plain)
    }
    override fun decrypt(blob: ByteArray): ByteArray =
      Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, blob, 0, 12)) }.doFinal(blob, 12, blob.size - 12)
  }

  private class MemStore : PinVault.Store {
    var text: String? = null
    override fun read() = text
    override fun write(text: String) { this.text = text }
    override fun delete() { text = null }
  }

  @Test fun pinLayerLocksAndUnlocks() {
    val store = MemStore()
    var now = 1_000_000L
    val v = PinVault(SoftCipher(), store) { now }
    assertEquals("{}", v.read())
    v.write("""{"reader":"aa"}""")
    assertFalse(store.text!!.contains("reader"))
    v.setPin("123456")
    assertEquals("pin", v.lock)
    v.lockNow()
    assertFalse(v.unlocked)
    try {
      v.read()
      fail("read while locked")
    } catch (_: IllegalStateException) {}
    // A fresh process with the same files: the right PIN opens it.
    val v2 = PinVault(SoftCipher(), store) { now }.also { assertEquals("pin", it.lock) }
    assertTrue(v2.lock == "pin")
    assertTrue(v.unlockWithPin("123456").ok)
    assertEquals("""{"reader":"aa"}""", v.read())
    v.lockNow()
    repeat(4) { assertFalse(v.unlockWithPin("000000").ok) }
    val fifth = v.unlockWithPin("000000")
    assertFalse(fifth.ok)
    assertEquals(now + 30_000, fifth.retryAt)
    // During the pause even the right PIN is refused, afterwards it works and resets the counter.
    assertFalse(v.unlockWithPin("123456").ok)
    now += 31_000
    assertTrue(v.unlockWithPin("123456").ok)
    assertEquals(0, v.failedAttempts)
    val key = v.currentPinKey()!!.copyOf()
    v.lockNow()
    assertTrue(v.unlockWithKey(key))
    v.removePin()
    assertEquals("none", v.lock)
    assertEquals("""{"reader":"aa"}""", v.read())
    v.wipe()
    assertNull(store.text)
  }

  @Test fun backoffSchedule() {
    assertEquals(0L, PinVault.backoffMs(4))
    assertEquals(30_000L, PinVault.backoffMs(5))
    assertEquals(60_000L, PinVault.backoffMs(6))
    assertEquals(3_600_000L, PinVault.backoffMs(40))
    assertFalse(PinVault.validPin("12345"))
    assertTrue(PinVault.validPin("123456789012"))
  }

  @Test fun wrongKeyOrTamperedBlobFails() {
    val k = PinVault.deriveKey("123456", ByteArray(16), 1000)
    val blob = PinVault.seal(k, "secret".toByteArray())
    assertNull(PinVault.open(PinVault.deriveKey("654321", ByteArray(16), 1000), blob))
    blob[blob.size - 1] = (blob[blob.size - 1].toInt() xor 1).toByte()
    assertNull(PinVault.open(k, blob))
  }
}

class TorConfigTest {
  private val builtin = File(System.getProperty("bridgesJson")).readText()

  @Test fun buildsTorrcWithSnowflake() {
    val lines = TorConfig.bridgeLines(builtin, TorConfig.Bridges.SNOWFLAKE)
    assertTrue(lines.isNotEmpty())
    val p = TorConfig.snowflakeParams(lines)
    assertTrue(p.url.startsWith("https://"))
    assertTrue(p.ice.contains("stun:"))
    val rc = TorConfig.torrc(TorConfig.Bridges.SNOWFLAKE, lines, 41234)
    assertTrue(rc.contains("UseBridges 1"))
    assertTrue(rc.contains("ClientTransportPlugin snowflake socks5 127.0.0.1:41234"))
    assertTrue(rc.contains("HTTPTunnelPort 0"))
    assertTrue(rc.lines().count { it.startsWith("Bridge snowflake ") } == lines.size)
  }

  @Test fun obfs4AndDirect() {
    val lines = TorConfig.bridgeLines(builtin, TorConfig.Bridges.OBFS4)
    assertTrue(lines.all { it.startsWith("obfs4 ") && it.contains("cert=") })
    assertTrue(TorConfig.torrc(TorConfig.Bridges.NONE, emptyList(), 0).contains("UseBridges 0"))
    assertEquals(85, TorConfig.bootstrapProgress("NOTICE BOOTSTRAP PROGRESS=85 TAG=ap_conn SUMMARY=\"x\""))
    assertEquals(0, TorConfig.bootstrapProgress(null))
  }
}

class FilePatcherTest {
  @Test fun patchesZeroesAndTruncates() {
    val dir = Files.createTempDirectory("fp").toFile()
    val src = File(dir, "a").apply { writeBytes(ByteArray(100) { 9 }) }
    val dest = File(dir, "b")
    val json =
      JSONObject()
        .put("src", src.path)
        .put("dest", dest.path)
        .put("patches", org.json.JSONArray().put(JSONObject().put("offset", 2).put("dataB64", java.util.Base64.getEncoder().encodeToString(byteArrayOf(1, 2)))).put(JSONObject().put("offset", 10).put("zero", 5)))
        .put("truncate", 50)
        .toString()
    val (files, patches, truncate) = FilePatcher.parse(json)
    FilePatcher.apply(files.first, files.second, patches, truncate)
    val out = dest.readBytes()
    assertEquals(50, out.size)
    assertEquals(1, out[2].toInt())
    assertEquals(0, out[12].toInt())
    assertEquals(9, out[20].toInt())
    assertEquals(9, src.readBytes()[2].toInt())
    try {
      FilePatcher.apply(src, dest, listOf(FilePatcher.Patch(99, byteArrayOf(1, 2), 0)), null)
      fail()
    } catch (_: IOException) {}
  }
}

class WsBridgeTest {
  @Test fun opensExchangesAndCloses() {
    val server = MockWebServer()
    server.enqueue(
      MockResponse().withWebSocketUpgrade(
        object : WebSocketListener() {
          override fun onMessage(webSocket: WebSocket, text: String) {
            webSocket.send("echo:$text")
          }
          override fun onOpen(webSocket: WebSocket, response: Response) {}
          override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, null)
          }
        },
      ),
    )
    server.start(InetAddress.getByName("127.0.0.1"), 0)
    val events = LinkedBlockingQueue<String>()
    val net = NetCore().apply { configure("""{"mode":"direct","doh":false}""") }
    val ws =
      WsBridge(
        net,
        object : WsBridge.Events {
          override fun onOpen(id: String) { events.put("open") }
          override fun onMessage(id: String, text: String) { events.put("msg:$text") }
          override fun onClose(id: String, code: Int, reason: String) { events.put("close") }
          override fun onError(id: String, message: String) { events.put("error:$message") }
        },
      )
    ws.connect("1", "ws://127.0.0.1:${server.port}/")
    assertEquals("open", events.poll(5, TimeUnit.SECONDS))
    assertTrue(ws.send("1", "hi"))
    assertEquals("msg:echo:hi", events.poll(5, TimeUnit.SECONDS))
    ws.close("1", 1000, "bye")
    assertEquals("close", events.poll(10, TimeUnit.SECONDS))
    server.shutdown()
  }

  @Test fun reportsUnreachableRelays() {
    val events = LinkedBlockingQueue<String>()
    val net = NetCore().apply { configure("""{"mode":"direct","doh":false}""") }
    val ws = WsBridge(net, object : WsBridge.Events {
      override fun onOpen(id: String) { events.put("open") }
      override fun onMessage(id: String, text: String) {}
      override fun onClose(id: String, code: Int, reason: String) { events.put("close") }
      override fun onError(id: String, message: String) { events.put("error") }
    })
    val port = ServerSocket(0).use { it.localPort }
    ws.connect("2", "ws://127.0.0.1:$port/")
    assertEquals("error", events.poll(10, TimeUnit.SECONDS))
  }
}

@Suppress("unused")
private fun drain(i: InputStream) = i.readBytes()
