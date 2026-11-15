package expo.modules.t3phonecontrol

/** The companion's status contract (C1): only these keys cross into JavaScript. */
object PhoneControlStatus {
  const val COMPANION_PACKAGE = "ca.skofo.phonecontrol"
  const val AUTHORITY = "ca.skofo.phonecontrol.status"
  const val STATE_PATH = "state"

  private val booleanKeys =
    listOf("hubConnected", "paused", "agentActive", "viewing", "accessibilityEnabled")
  private val longKeys =
    listOf("ownerTookOverAtMillis", "lastRemoteCommandAtMillis")
  private val modes = setOf("unattended", "manual", "off")
  private val kinds = setOf("ui", "background", "none")

  /** Reads a provider result through [get]; unknown or mistyped values fall back to safe ones. */
  fun fromValues(get: (String) -> Any?): Map<String, Any> {
    val result = mutableMapOf<String, Any>()
    result["companionVersion"] = (get("companionVersion") as? String)?.take(40) ?: "unknown"
    result["controlMode"] = (get("controlMode") as? String)?.takeIf { it in modes } ?: "off"
    result["lastRemoteCommandKind"] =
      (get("lastRemoteCommandKind") as? String)?.takeIf { it in kinds } ?: "none"
    for (key in booleanKeys) result[key] = get(key) as? Boolean ?: false
    for (key in longKeys) result[key] = ((get(key) as? Number)?.toLong() ?: 0L).coerceAtLeast(0L)
    return result
  }
}
