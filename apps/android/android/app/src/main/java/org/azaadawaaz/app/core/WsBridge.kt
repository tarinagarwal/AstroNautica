package org.azaadawaaz.app.core

import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/** Relay WebSockets on the shared client (so they follow Tor/DoH like everything else). */
class WsBridge(private val net: NetCore, private val events: Events) {
  interface Events {
    fun onOpen(id: String)
    fun onMessage(id: String, text: String)
    fun onClose(id: String, code: Int, reason: String)
    fun onError(id: String, message: String)
  }

  private val sockets = ConcurrentHashMap<String, WebSocket>()

  fun connect(id: String, url: String) {
    val blocked = net.blockedReason()
    if (blocked != null) {
      events.onError(id, blocked)
      return
    }
    val req =
      try {
        Request.Builder().url(url).build()
      } catch (e: IllegalArgumentException) {
        events.onError(id, e.message ?: "invalid URL")
        return
      }
    val client = net.client().newBuilder().pingInterval(30, TimeUnit.SECONDS).build()
    sockets[id] =
      client.newWebSocket(
        req,
        object : WebSocketListener() {
          override fun onOpen(webSocket: WebSocket, response: Response) = events.onOpen(id)

          override fun onMessage(webSocket: WebSocket, text: String) = events.onMessage(id, text)

          override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, null)
          }

          override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            sockets.remove(id)
            events.onClose(id, code, reason)
          }

          override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            sockets.remove(id)
            events.onError(id, t.message ?: t.javaClass.simpleName)
          }
        },
      )
  }

  fun send(id: String, text: String): Boolean = sockets[id]?.send(text) ?: false

  fun close(id: String, code: Int, reason: String) {
    val ws = sockets[id] ?: return
    if (!ws.close(if (code in 1000..4999) code else 1000, reason.take(120))) {
      ws.cancel()
      sockets.remove(id)
      events.onClose(id, code, reason)
    }
  }

  fun closeAll() {
    sockets.values.forEach { it.cancel() }
    sockets.clear()
  }
}
