package expo.modules.t3phonecontrol

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognizerIntent

/**
 * The digital-assistant entry point (long-press power). It asks the system speech recognizer for
 * one request, hands the words to the app in memory and opens the app. It never reads the
 * extras or data of the intent that started it, and it asks only a recognizer that came with
 * the phone, so another app cannot supply the text.
 */
class AssistActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (savedInstanceState != null) return
    val speech =
      Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        .putExtra(RecognizerIntent.EXTRA_PROMPT, "What should Claude do on your phone?")
        .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
    val recognizer = systemRecognizer(speech)
    if (recognizer == null) {
      // No recognizer that came with the phone: open an empty composer for the keyboard.
      handOff("")
      return
    }
    speech.component = recognizer
    try {
      @Suppress("DEPRECATION")
      startActivityForResult(speech, SPEECH_REQUEST)
    } catch (_: ActivityNotFoundException) {
      // No recognizer on this phone: open an empty composer and let the keyboard take over.
      handOff("")
    } catch (_: SecurityException) {
      handOff("")
    }
  }

  @Deprecated("Activity result API needs androidx; this activity has no dependencies.")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    @Suppress("DEPRECATION")
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode != SPEECH_REQUEST) return
    if (resultCode != RESULT_OK) {
      // Backing out of the recognizer cancels the request.
      finish()
      return
    }
    handOff(data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull().orEmpty())
  }

  /** A recognizer from the system image (or its update); an installed app could fake the words. */
  private fun systemRecognizer(speech: Intent): ComponentName? {
    val system = ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP
    val candidates =
      packageManager
        .queryIntentActivities(speech, PackageManager.MATCH_DEFAULT_ONLY)
        .filter { (it.activityInfo.applicationInfo.flags and system) != 0 }
    val preferred =
      packageManager.resolveActivity(speech, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo
    val chosen =
      candidates.firstOrNull {
        it.activityInfo.packageName == preferred?.packageName && it.activityInfo.name == preferred.name
      } ?: candidates.firstOrNull()
    return chosen?.activityInfo?.let { ComponentName(it.packageName, it.name) }
  }

  private fun handOff(text: String) {
    AssistHandoff.offer(text)
    packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
      startActivity(launch)
    }
    finish()
  }

  private companion object {
    const val SPEECH_REQUEST = 7301
  }
}
