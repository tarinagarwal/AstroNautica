package org.azaadawaaz.app.core

import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.dnsoverhttps.DnsOverHttps
import org.json.JSONObject
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit

/**
 * The one HTTP stack of the app (spec §8.2). Direct mode resolves names with DNS-over-HTTPS (several resolvers
 * reached by IP address, so no plain DNS lookup is needed to find them); Tor mode sends everything to Tor's SOCKS port
 * with names resolved by Tor (OkHttp passes unresolved addresses to SOCKS proxies, so nothing leaks to local DNS);
 * "blocked" refuses all requests while Tor is wanted but not connected yet.
 */
class NetCore(private val dohResolvers: List<DohResolver> = DohResolver.DEFAULTS) {
  sealed class Mode {
    data object Direct : Mode()
    data class Tor(val socksPort: Int) : Mode()
    data object Blocked : Mode()
  }

  data class DohResolver(val url: String, val bootstrap: List<String>) {
    companion object {
      /** Quad9, Cloudflare and Mullvad, each reached by IP address. */
      val DEFAULTS =
        listOf(
          DohResolver("https://dns.quad9.net/dns-query", listOf("9.9.9.9", "149.112.112.112", "2620:fe::fe")),
          DohResolver("https://cloudflare-dns.com/dns-query", listOf("1.1.1.1", "1.0.0.1", "2606:4700:4700::1111")),
          DohResolver("https://dns.mullvad.net/dns-query", listOf("194.242.2.2", "2a07:e340::2")),
        )
    }
  }

  @Volatile var mode: Mode = Mode.Direct
    private set
  @Volatile var doh: Boolean = true
    private set

  private val base: OkHttpClient =
    OkHttpClient.Builder()
      .connectTimeout(20, TimeUnit.SECONDS)
      .readTimeout(60, TimeUnit.SECONDS)
      .writeTimeout(60, TimeUnit.SECONDS)
      .retryOnConnectionFailure(true)
      .build()

  /** Resolves the DoH servers' own names from their bootstrap IPs only. */
  val dohDns: Dns by lazy { ChainedDns(dohResolvers.map { buildDoh(it) }, fallback = Dns.SYSTEM) }

  private fun buildDoh(r: DohResolver): Dns =
    DnsOverHttps.Builder()
      .client(base)
      .url(r.url.toHttpUrl())
      .bootstrapDnsHosts(r.bootstrap.map { InetAddress.getByName(it) })
      .includeIPv6(true)
      .resolvePrivateAddresses(true)
      .build()

  @Volatile private var cached: Pair<Pair<Mode, Boolean>, OkHttpClient>? = null

  /** `{"mode":"direct"|"tor"|"blocked","socksPort"?:n,"doh":bool}` */
  fun configure(json: String) {
    val o = JSONObject(json)
    mode =
      when (o.optString("mode", "direct")) {
        "tor" -> Mode.Tor(o.optInt("socksPort").also { require(it in 1..65535) { "invalid SOCKS port" } })
        "blocked" -> Mode.Blocked
        else -> Mode.Direct
      }
    doh = o.optBoolean("doh", true)
  }

  /** The client for the current mode (rebuilt only when the mode changes; connection pools are shared). */
  fun client(): OkHttpClient {
    val key = mode to doh
    cached?.let { if (it.first == key) return it.second }
    val c =
      when (val m = mode) {
        is Mode.Tor -> base.newBuilder().proxy(Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", m.socksPort))).dns(NoLocalDns).build()
        Mode.Blocked -> base.newBuilder().dns(BlockedDns).proxy(Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", 9))).build()
        Mode.Direct -> if (doh) base.newBuilder().dns(OnionGuardDns(dohDns)).build() else base.newBuilder().dns(OnionGuardDns(Dns.SYSTEM)).build()
      }
    cached = key to c
    return c
  }

  fun blockedReason(): String? = if (mode == Mode.Blocked) "Tor is connecting; requests wait for it" else null

  /** Tries each resolver in turn; the system resolver is the last resort (a poisoned answer still fails TLS). */
  class ChainedDns(private val resolvers: List<Dns>, private val fallback: Dns?) : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
      var last: IOException? = null
      for (r in resolvers) {
        try {
          val res = r.lookup(hostname)
          if (res.isNotEmpty()) return res
        } catch (e: IOException) {
          last = e
        }
      }
      fallback?.let {
        try {
          return it.lookup(hostname)
        } catch (e: IOException) {
          last = e
        }
      }
      throw last ?: UnknownHostException(hostname)
    }
  }

  /** .onion names only resolve inside Tor; never send them to any DNS resolver. */
  class OnionGuardDns(private val inner: Dns) : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
      if (hostname.endsWith(".onion", ignoreCase = true)) throw UnknownHostException("$hostname needs Tor")
      return inner.lookup(hostname)
    }
  }

  /** In Tor mode OkHttp hands hostnames to the SOCKS proxy; any local lookup would be a leak, so refuse it. */
  object NoLocalDns : Dns {
    override fun lookup(hostname: String): List<InetAddress> = throw UnknownHostException("no local DNS while using Tor: $hostname")
  }

  object BlockedDns : Dns {
    override fun lookup(hostname: String): List<InetAddress> = throw UnknownHostException("Tor is connecting")
  }
}
