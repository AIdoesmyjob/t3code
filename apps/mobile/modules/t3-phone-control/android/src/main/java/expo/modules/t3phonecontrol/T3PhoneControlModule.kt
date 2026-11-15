package expo.modules.t3phonecontrol

import android.app.role.RoleManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.database.ContentObserver
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Status and Stop for the phone-control companion, and the long-press-power handoff. */
class T3PhoneControlModule : Module() {
  private var statusObserver: ContentObserver? = null
  private val assistListener: () -> Unit = { sendEvent(ASSIST_EVENT, emptyMap<String, Any>()) }

  private val context: Context
    get() = requireNotNull(appContext.reactContext)

  override fun definition() = ModuleDefinition {
    Name("T3PhoneControl")

    Events(ASSIST_EVENT, STATUS_EVENT)

    Function("takeAssistRequest") {
      AssistHandoff.take()?.let { mapOf("text" to it.text, "atMillis" to it.atMillis) }
    }

    Function("isDefaultAssistant") {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
        context.getSystemService(RoleManager::class.java)?.isRoleHeld(RoleManager.ROLE_ASSISTANT) == true
    }

    Function("openAssistantSettings") {
      openFirst(
        Intent(Settings.ACTION_VOICE_INPUT_SETTINGS),
        Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS),
        Intent(Settings.ACTION_SETTINGS),
      )
    }

    Function("moveToBackground") { appContext.currentActivity?.moveTaskToBack(true) ?: false }

    Function("status") { readStatus() }

    Function("pause") { callProvider("pause") }

    Function("openCompanion") {
      val launch = context.packageManager.getLaunchIntentForPackage(PhoneControlStatus.COMPANION_PACKAGE)
      launch != null && openFirst(launch)
    }

    OnStartObserving(ASSIST_EVENT) { AssistHandoff.addListener(assistListener) }
    OnStopObserving(ASSIST_EVENT) { AssistHandoff.removeListener(assistListener) }
    OnStartObserving(STATUS_EVENT) { observeStatus() }
    OnStopObserving(STATUS_EVENT) { stopObservingStatus() }
    OnDestroy {
      AssistHandoff.removeListener(assistListener)
      stopObservingStatus()
    }
  }

  /** `installed:false` without the genuine companion; `reachable:false` when it refused us. */
  private fun readStatus(): Map<String, Any?> {
    if (!companionOwnsProvider()) return mapOf("installed" to false, "reachable" to false)
    return callProvider("status")
  }

  private fun callProvider(method: String): Map<String, Any?> {
    if (!companionOwnsProvider()) return mapOf("installed" to false, "reachable" to false)
    val bundle =
      try {
        context.contentResolver.call(Uri.parse("content://${PhoneControlStatus.AUTHORITY}"), method, null, null)
      } catch (_: SecurityException) {
        null
      } catch (_: IllegalArgumentException) {
        null
      } catch (_: IllegalStateException) {
        null
      }
    if (bundle == null) return mapOf("installed" to true, "reachable" to false)
    @Suppress("DEPRECATION")
    val status = PhoneControlStatus.fromValues { key -> bundle.get(key) }
    return mapOf("installed" to true, "reachable" to true, "status" to status)
  }

  private fun companionOwnsProvider(): Boolean =
    try {
      context.packageManager.resolveContentProvider(PhoneControlStatus.AUTHORITY, 0)?.packageName ==
        PhoneControlStatus.COMPANION_PACKAGE
    } catch (_: RuntimeException) {
      false
    }

  private fun observeStatus() {
    if (statusObserver != null) return
    val observer =
      object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) {
          sendEvent(STATUS_EVENT, emptyMap<String, Any>())
        }
      }
    try {
      context.contentResolver.registerContentObserver(
        Uri.parse("content://${PhoneControlStatus.AUTHORITY}/${PhoneControlStatus.STATE_PATH}"),
        true,
        observer,
      )
      statusObserver = observer
    } catch (_: SecurityException) {
      // Without the companion there is nothing to observe; the card shows "not installed".
    }
  }

  private fun stopObservingStatus() {
    statusObserver?.let { context.contentResolver.unregisterContentObserver(it) }
    statusObserver = null
  }

  private fun openFirst(vararg intents: Intent): Boolean {
    for (intent in intents) {
      try {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        return true
      } catch (_: ActivityNotFoundException) {
        continue
      } catch (_: SecurityException) {
        continue
      }
    }
    return false
  }

  private companion object {
    const val ASSIST_EVENT = "onAssist"
    const val STATUS_EVENT = "onStatusChange"
  }
}
