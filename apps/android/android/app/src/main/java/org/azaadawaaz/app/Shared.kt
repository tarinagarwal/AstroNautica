package org.azaadawaaz.app

import android.content.Context
import com.goterl.lazysodium.SodiumAndroid
import org.azaadawaaz.app.core.HttpBridge
import org.azaadawaaz.app.core.NetCore
import org.azaadawaaz.app.core.SodiumOps
import org.azaadawaaz.app.core.TrustlessIpfs
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/** Process-wide singletons shared by the native modules and the media provider. */
object Shared {
  val net: NetCore by lazy { NetCore() }
  val http: HttpBridge by lazy { HttpBridge(net) }
  val sodium: SodiumOps by lazy { SodiumOps(SodiumAndroid()) }
  /** IPFS gateways for HLS playback, best first (set from JS, which ranks them). */
  val mediaGateways = CopyOnWriteArrayList<String>()
  val ipfs: TrustlessIpfs by lazy { TrustlessIpfs({ net.client() }, { mediaGateways.toList() }) }
  /** Blocking work (network, files, crypto) never runs on the JS or UI thread. */
  val io = Executors.newCachedThreadPool { r -> Thread(r, "azaad-io").apply { isDaemon = true } }

  @Volatile var pendingIntent: Map<String, String>? = null
  @Volatile var onIntent: (() -> Unit)? = null

  lateinit var appContext: Context
}
