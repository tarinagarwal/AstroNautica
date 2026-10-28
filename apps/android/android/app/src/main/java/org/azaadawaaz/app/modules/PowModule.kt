package org.azaadawaaz.app.modules

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import org.azaadawaaz.app.core.PowMiner
import org.azaadawaaz.app.specs.NativeAzaadPowSpec
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/** NIP-13 mining on a background thread (spec §7), so the UI never stalls while a comment is being posted. */
class PowModule(ctx: ReactApplicationContext) : NativeAzaadPowSpec(ctx) {
  private val jobs = ConcurrentHashMap<String, AtomicBoolean>()

  override fun mine(jobId: String, prefix: String, suffix: String, difficulty: Double, startNonce: Double, promise: Promise) {
    val flag = AtomicBoolean(false)
    jobs[jobId] = flag
    promise.runIo {
      try {
        PowMiner.mine(prefix, suffix, difficulty.toInt(), startNonce.toLong(), flag).toString()
      } finally {
        jobs.remove(jobId)
      }
    }
  }

  override fun cancel(jobId: String) {
    jobs[jobId]?.set(true)
  }
}
