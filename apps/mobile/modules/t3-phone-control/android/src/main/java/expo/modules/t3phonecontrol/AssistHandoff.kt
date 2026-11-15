package expo.modules.t3phonecontrol

import java.util.concurrent.CopyOnWriteArraySet

/**
 * Holds the one spoken request between the assistant activity and JavaScript. It lives only in
 * this process's memory, so no other app (and no deep link) can plant the text; a request that
 * nobody picked up within [MAX_AGE_MILLIS] is dropped.
 */
object AssistHandoff {
  const val MAX_AGE_MILLIS = 120_000L

  data class Request(val text: String, val atMillis: Long)

  private var pending: Request? = null
  private val listeners = CopyOnWriteArraySet<() -> Unit>()

  fun offer(text: String, nowMillis: Long = System.currentTimeMillis()) {
    synchronized(this) { pending = Request(text.trim(), nowMillis) }
    listeners.forEach { it() }
  }

  fun take(nowMillis: Long = System.currentTimeMillis()): Request? =
    synchronized(this) {
      val request = pending
      pending = null
      request?.takeIf { nowMillis - it.atMillis in 0..MAX_AGE_MILLIS }
    }

  fun addListener(listener: () -> Unit) {
    listeners.add(listener)
  }

  fun removeListener(listener: () -> Unit) {
    listeners.remove(listener)
  }
}
