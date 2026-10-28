package org.azaadawaaz.app.core

import org.json.JSONObject

/**
 * The torrc written before tor-android starts (spec §8.2): a random SOCKS port, no HTTP tunnel, DNS or transparent
 * ports, and, when bridges are chosen, the pluggable transport (run in-process by IPtProxy on a local SOCKS port)
 * plus the bridge lines. The built-in bridge lines are Tor Browser's public defaults (assets/builtin-bridges.json).
 */
object TorConfig {
  enum class Bridges(val id: String, val transport: String?) {
    NONE("none", null),
    SNOWFLAKE("snowflake", "snowflake"),
    OBFS4("obfs4", "obfs4");

    companion object {
      fun of(id: String) = entries.firstOrNull { it.id == id } ?: NONE
    }
  }

  data class Snowflake(val url: String, val fronts: String, val ice: String)

  fun bridgeLines(builtinJson: String, bridges: Bridges): List<String> {
    if (bridges == Bridges.NONE) return emptyList()
    val arr = JSONObject(builtinJson).optJSONArray(bridges.id) ?: return emptyList()
    return (0 until arr.length()).map { arr.getString(it).trim() }.filter { it.startsWith(bridges.transport!! + " ") }
  }

  /** Broker URL, front domains and ICE servers for IPtProxy's Snowflake client, taken from the first bridge line. */
  fun snowflakeParams(lines: List<String>): Snowflake {
    val args = lines.firstOrNull()?.split(' ')?.mapNotNull { p -> p.split('=', limit = 2).takeIf { it.size == 2 }?.let { it[0] to it[1] } }?.toMap() ?: emptyMap()
    val fronts = listOfNotNull(args["fronts"], args["front"]).joinToString(",")
    return Snowflake(args["url"] ?: "", fronts, args["ice"] ?: "")
  }

  /** The torrc text. `transportPort` is the local port IPtProxy listens on for this transport. */
  fun torrc(bridges: Bridges, lines: List<String>, transportPort: Int): String {
    val out = mutableListOf(
      "SOCKSPort auto",
      "HTTPTunnelPort 0",
      "DNSPort 0",
      "TransPort 0",
      "ClientOnly 1",
      "AvoidDiskWrites 1",
      "SafeSocks 0",
    )
    if (bridges != Bridges.NONE) {
      require(transportPort in 1..65535) { "transport port missing" }
      require(lines.isNotEmpty()) { "no ${bridges.id} bridges available" }
      out += "UseBridges 1"
      out += "ClientTransportPlugin ${bridges.transport} socks5 127.0.0.1:$transportPort"
      lines.forEach { out += "Bridge $it" }
    } else out += "UseBridges 0"
    return out.joinToString("\n") + "\n"
  }

  /** "PROGRESS=nn" from a `status/bootstrap-phase` reply. */
  fun bootstrapProgress(phase: String?): Int = phase?.let { Regex("PROGRESS=(\\d+)").find(it)?.groupValues?.get(1)?.toIntOrNull() } ?: 0
}
