package org.azaadawaaz.app.modules

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.NetworkInfo
import android.net.wifi.WpsInfo
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pDeviceList
import android.net.wifi.p2p.WifiP2pInfo
import android.net.wifi.p2p.WifiP2pManager
import android.os.Build
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import org.azaadawaaz.app.Shared
import org.azaadawaaz.app.core.Hashing
import org.azaadawaaz.app.core.P2pProtocol
import org.azaadawaaz.app.specs.NativeAzaadP2PSpec
import java.io.File
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Story bundles over Wi-Fi Direct (android.net.wifi.p2p; no Google Play services). Both phones discover each other;
 * the sender connects to the receiver; once a group forms, the group owner listens on a TCP port and the other side
 * connects, then P2pProtocol moves the file (roles are exchanged in the hello, so either phone may be group owner).
 */
class P2PModule(ctx: ReactApplicationContext) : NativeAzaadP2PSpec(ctx) {
  companion object {
    const val PORT = 48619
  }

  private var manager: WifiP2pManager? = null
  private var channel: WifiP2pManager.Channel? = null
  private var receiver: BroadcastReceiver? = null
  private var role = "receive"
  private var path = ""
  private val transferring = AtomicBoolean(false)
  @Volatile private var server: ServerSocket? = null

  private fun emit(type: String, fill: WritableMap.() -> Unit = {}) {
    val m = Arguments.createMap()
    m.putString("type", type)
    m.fill()
    reactApplicationContext.emitDeviceEvent("azaadP2p", m)
  }

  private fun state(s: String, message: String? = null) = emit("state") {
    putString("state", s)
    message?.let { putString("message", it) }
  }

  override fun isSupported(promise: Promise) =
    promise.resolve(reactApplicationContext.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT))

  @SuppressLint("MissingPermission")
  override fun start(role: String, filePath: String, promise: Promise) {
    this.role = if (role == "send") "send" else "receive"
    this.path = filePath
    val ctx = reactApplicationContext
    val m = ctx.getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager ?: return promise.reject("unsupported", "Wi-Fi Direct is not available")
    manager = m
    val ch = m.initialize(ctx, Looper.getMainLooper(), null)
    channel = ch
    val filter =
      IntentFilter().apply {
        addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION)
        addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION)
        addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION)
      }
    val r =
      object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
          when (intent.action) {
            WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION -> m.requestPeers(ch) { list -> emitPeers(list) }
            WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION -> {
              @Suppress("DEPRECATION")
              val info = intent.getParcelableExtra<NetworkInfo>(WifiP2pManager.EXTRA_NETWORK_INFO)
              if (info?.isConnected == true) m.requestConnectionInfo(ch) { onConnected(it) } else state("disconnected")
            }
            WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION -> {
              val enabled = intent.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE, -1) == WifiP2pManager.WIFI_P2P_STATE_ENABLED
              if (!enabled) state("wifi-off", "Turn on Wi-Fi to use Wi-Fi Direct")
            }
          }
        }
      }
    receiver = r
    if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(r, filter, Context.RECEIVER_NOT_EXPORTED) else ctx.registerReceiver(r, filter)
    m.discoverPeers(
      ch,
      object : WifiP2pManager.ActionListener {
        override fun onSuccess() = state("discovering")

        override fun onFailure(reason: Int) = emit("error") { putString("message", "discovery failed ($reason)") }
      },
    )
    promise.resolve(null)
  }

  private fun emitPeers(list: WifiP2pDeviceList) =
    emit("peers") {
      val arr = Arguments.createArray()
      list.deviceList.forEach { d ->
        val p = Arguments.createMap()
        p.putString("name", d.deviceName ?: "")
        p.putString("address", d.deviceAddress ?: "")
        p.putInt("status", d.status)
        arr.pushMap(p)
      }
      putArray("peers", arr)
    }

  @SuppressLint("MissingPermission")
  override fun connect(deviceAddress: String, promise: Promise) {
    val m = manager ?: return promise.reject("not-started", "call start first")
    val config =
      WifiP2pConfig().apply {
        this.deviceAddress = deviceAddress
        @Suppress("DEPRECATION")
        wps.setup = WpsInfo.PBC
      }
    m.connect(
      channel,
      config,
      object : WifiP2pManager.ActionListener {
        override fun onSuccess() {
          state("connecting")
          promise.resolve(null)
        }

        override fun onFailure(reason: Int) = promise.reject("error", "connection failed ($reason)")
      },
    )
  }

  private fun onConnected(info: WifiP2pInfo) {
    if (!info.groupFormed || !transferring.compareAndSet(false, true)) return
    state("connected")
    Shared.io.execute {
      try {
        val socket =
          if (info.isGroupOwner) {
            ServerSocket().apply {
              reuseAddress = true
              bind(InetSocketAddress(PORT))
              soTimeout = 120_000
              server = this
            }.use { it.accept() }
          } else {
            var s: Socket? = null
            for (attempt in 0 until 20) {
              try {
                s = Socket().apply { connect(InetSocketAddress(info.groupOwnerAddress, PORT), 5000) }
                break
              } catch (e: Exception) {
                Thread.sleep(1000)
              }
            }
            s ?: throw java.io.IOException("could not reach the other phone")
          }
        socket.use { sock ->
          sock.soTimeout = 120_000
          val input = sock.getInputStream().buffered()
          val out = sock.getOutputStream().buffered()
          P2pProtocol.handshake(input, out, role)
          if (role == "send") {
            P2pProtocol.send(input, out, File(path)) { b, t -> progress(b, t) }
            emit("sent")
          } else {
            val (file, sha) = P2pProtocol.receive(input, out, File(path)) { b, t -> progress(b, t) }
            emit("received") {
              putString("path", file.absolutePath)
              putDouble("size", file.length().toDouble())
              putString("sha256", sha)
            }
          }
        }
      } catch (e: Exception) {
        emit("error") { putString("message", e.message ?: e.javaClass.simpleName) }
      } finally {
        transferring.set(false)
        server = null
        manager?.removeGroup(channel, null)
      }
    }
  }

  private var lastProgress = 0L

  private fun progress(bytes: Long, total: Long) {
    if (bytes - lastProgress < 256 * 1024 && bytes != total) return
    lastProgress = bytes
    emit("progress") {
      putDouble("bytes", bytes.toDouble())
      putDouble("total", total.toDouble())
    }
  }

  override fun stop(promise: Promise) {
    runCatching { server?.close() }
    receiver?.let { runCatching { reactApplicationContext.unregisterReceiver(it) } }
    receiver = null
    manager?.let { m ->
      m.stopPeerDiscovery(channel, null)
      m.removeGroup(channel, null)
    }
    if (Build.VERSION.SDK_INT >= 27) channel?.close()
    channel = null
    manager = null
    promise.resolve(null)
  }

  override fun addListener(eventName: String) {}

  override fun removeListeners(count: Double) {}
}
