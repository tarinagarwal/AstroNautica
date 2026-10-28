package org.azaadawaaz.app.modules

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import org.azaadawaaz.app.Shared
import org.azaadawaaz.app.core.WsBridge
import org.azaadawaaz.app.specs.NativeAzaadNetSpec
import org.json.JSONObject

class NetModule(ctx: ReactApplicationContext) : NativeAzaadNetSpec(ctx) {
  private val ws =
    WsBridge(
      Shared.net,
      object : WsBridge.Events {
        override fun onOpen(id: String) = emit(id, "open")
        override fun onMessage(id: String, text: String) = emit(id, "message", data = text)
        override fun onClose(id: String, code: Int, reason: String) = emit(id, "close", code = code, reason = reason)
        override fun onError(id: String, message: String) = emit(id, "error", reason = message)
      },
    )

  private fun emit(id: String, type: String, data: String? = null, code: Int? = null, reason: String? = null) {
    val m = Arguments.createMap()
    m.putString("id", id)
    m.putString("type", type)
    data?.let { m.putString("data", it) }
    code?.let { m.putInt("code", it) }
    reason?.let { m.putString("reason", it) }
    reactApplicationContext.emitDeviceEvent("azaadWs", m)
  }

  override fun configure(configJson: String) {
    Shared.net.configure(configJson)
  }

  override fun request(requestId: String, requestJson: String, promise: Promise) = promise.runIo { Shared.http.request(requestId, requestJson) }

  override fun cancel(requestId: String) = Shared.http.cancel(requestId)

  override fun download(requestId: String, requestJson: String, promise: Promise) =
    promise.runIo {
      Shared.http.download(requestId, requestJson) { bytes, total ->
        val m = Arguments.createMap()
        m.putString("id", requestId)
        m.putDouble("bytes", bytes.toDouble())
        m.putDouble("total", total.toDouble())
        reactApplicationContext.emitDeviceEvent("azaadNetProgress", m)
      }
    }

  override fun upload(requestId: String, requestJson: String, promise: Promise) = promise.runIo { Shared.http.upload(requestId, requestJson) }

  override fun wsConnect(socketId: String, url: String) = ws.connect(socketId, url)

  override fun wsSend(socketId: String, text: String) {
    if (!ws.send(socketId, text)) emit(socketId, "error", reason = "socket is not open")
  }

  override fun wsClose(socketId: String, code: Double, reason: String) = ws.close(socketId, code.toInt(), reason)

  override fun setMediaSources(sourcesJson: String) {
    val arr = JSONObject(sourcesJson).optJSONArray("gateways")
    val list = (0 until (arr?.length() ?: 0)).map { arr!!.getString(it) }.filter { it.startsWith("https://") || it.startsWith("http://") }
    Shared.mediaGateways.clear()
    Shared.mediaGateways.addAll(list)
  }

  override fun addListener(eventName: String) {}

  override fun removeListeners(count: Double) {}

  override fun invalidate() {
    ws.closeAll()
    super.invalidate()
  }
}
