package org.azaadawaaz.app.modules

import IPtProxy.Controller
import IPtProxy.OnTransportEvents
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import org.azaadawaaz.app.Shared
import org.azaadawaaz.app.core.TorConfig
import org.azaadawaaz.app.specs.NativeAzaadTorSpec
import org.json.JSONObject
import org.torproject.jni.TorService
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Built-in Tor (spec §8.2): Guardian Project's tor-android runs tor in-process as a bound service; Snowflake and obfs4
 * run in-process through IPtProxy on local SOCKS ports that tor uses as pluggable transports. Status (bootstrap
 * progress, SOCKS port) is polled from tor's control connection and sent to JS as "azaadTor" events.
 */
class TorModule(ctx: ReactApplicationContext) : NativeAzaadTorSpec(ctx) {
  companion object {
    @Volatile private var controller: Controller? = null

    /** IPtProxy must be instantiated once per process. */
    fun controller(context: Context): Controller =
      controller ?: synchronized(this) {
        controller ?: Controller(File(context.noBackupFilesDir, "pt_state").absolutePath, false, false, "ERROR", object : OnTransportEvents {
          override fun connected(name: String?) {}
          override fun error(name: String?, error: Exception?) {}
          override fun stopped(name: String?, error: Exception?) {}
        }).also { controller = it }
      }
  }

  private val poller = Executors.newSingleThreadScheduledExecutor()
  @Volatile private var service: TorService? = null
  @Volatile private var connection: ServiceConnection? = null
  @Volatile private var state = "off"
  @Volatile private var bootstrap = 0
  @Volatile private var socksPort = 0
  @Volatile private var bridges = TorConfig.Bridges.NONE
  @Volatile private var error: String? = null
  private var poll: ScheduledFuture<*>? = null

  private fun statusJson(): String =
    JSONObject().put("state", state).put("socksPort", socksPort).put("bootstrap", bootstrap).put("bridges", bridges.id).apply { error?.let { put("error", it) } }.toString()

  private fun emit() {
    val m = Arguments.createMap()
    m.putString("state", state)
    m.putInt("socksPort", socksPort)
    m.putInt("bootstrap", bootstrap)
    m.putString("bridges", bridges.id)
    error?.let { m.putString("error", it) }
    reactApplicationContext.emitDeviceEvent("azaadTor", m)
  }

  override fun start(configJson: String, promise: Promise) =
    promise.runIo {
      if (state == "on" || state == "starting") return@runIo statusJson()
      val ctx = reactApplicationContext.applicationContext
      bridges = TorConfig.Bridges.of(JSONObject(configJson).optString("bridges", "snowflake"))
      error = null
      bootstrap = 0
      socksPort = 0
      state = "starting"
      emit()
      try {
        val builtin = ctx.assets.open("builtin-bridges.json").bufferedReader().use { it.readText() }
        val lines = TorConfig.bridgeLines(builtin, bridges)
        var port = 0
        if (bridges != TorConfig.Bridges.NONE) {
          val c = controller(ctx)
          if (bridges == TorConfig.Bridges.SNOWFLAKE) {
            val p = TorConfig.snowflakeParams(lines)
            c.snowflakeBrokerUrl = p.url
            c.snowflakeFrontDomains = p.fronts
            c.snowflakeIceServers = p.ice
            c.snowflakeAmpCacheUrl = ""
            c.snowflakeSqsUrl = ""
            c.snowflakeSqsCreds = ""
            c.snowflakeMaxPeers = 1L
          }
          c.start(bridges.transport!!, null)
          port = c.port(bridges.transport!!).toInt()
        }
        TorService.getTorrc(ctx).writeText(TorConfig.torrc(bridges, lines, port))
        bind(ctx)
        statusJson()
      } catch (e: Exception) {
        state = "error"
        error = e.message ?: e.javaClass.simpleName
        emit()
        statusJson()
      }
    }

  private fun bind(ctx: Context) {
    val conn =
      object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
          service = (binder as TorService.LocalBinder).service
          startPolling()
        }

        override fun onServiceDisconnected(name: ComponentName?) {
          service = null
          if (state != "off") {
            state = "error"
            error = "Tor stopped"
            emit()
          }
        }
      }
    connection = conn
    if (!ctx.bindService(Intent(ctx, TorService::class.java), conn, Context.BIND_AUTO_CREATE)) {
      connection = null
      throw IllegalStateException("could not start the Tor service")
    }
  }

  private fun startPolling() {
    poll?.cancel(false)
    poll =
      poller.scheduleWithFixedDelay(
        {
          val s = service ?: return@scheduleWithFixedDelay
          try {
            val phase = s.getInfo("status/bootstrap-phase")
            val progress = TorConfig.bootstrapProgress(phase)
            val circuit = s.getInfo("status/circuit-established")?.trim() == "1"
            val port = s.socksPort
            val next = if (progress >= 100 && circuit && port > 0) "on" else "starting"
            if (progress != bootstrap || next != state || port != socksPort) {
              bootstrap = progress
              socksPort = if (port > 0) port else 0
              state = next
              emit()
            }
          } catch (e: Exception) {
            // the control connection may not be ready yet
          }
        },
        1,
        1,
        TimeUnit.SECONDS,
      )
  }

  override fun stop(promise: Promise) =
    promise.runIo {
      state = "stopping"
      emit()
      poll?.cancel(false)
      connection?.let { runCatching { reactApplicationContext.applicationContext.unbindService(it) } }
      connection = null
      service = null
      if (bridges.transport != null) runCatching { controller(reactApplicationContext.applicationContext).stop(bridges.transport!!) }
      state = "off"
      bootstrap = 0
      socksPort = 0
      Shared.net.configure("{\"mode\":\"direct\",\"doh\":true}")
      emit()
    }

  override fun status(promise: Promise) = promise.resolve(statusJson())

  override fun addListener(eventName: String) {}

  override fun removeListeners(count: Double) {}

  override fun invalidate() {
    poller.shutdownNow()
    super.invalidate()
  }
}
