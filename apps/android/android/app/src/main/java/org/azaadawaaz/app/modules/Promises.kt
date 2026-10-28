package org.azaadawaaz.app.modules

import com.facebook.react.bridge.Promise
import org.azaadawaaz.app.Shared
import org.azaadawaaz.app.core.CodedException

/** Run blocking work off the JS thread and settle the promise; coded errors keep their code for the JS side. */
fun Promise.runIo(block: () -> Any?) {
  Shared.io.execute {
    try {
      when (val r = block()) {
        is Unit -> resolve(null)
        else -> resolve(r)
      }
    } catch (e: CodedException) {
      reject(e.code, e.message, e)
    } catch (e: Throwable) {
      reject("error", e.message ?: e.javaClass.simpleName, e)
    }
  }
}
