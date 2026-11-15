package expo.modules.t3phonecontrol

/** The companion's status contract (C1): only these keys cross into JavaScript. */
object PhoneControlStatus {
  const val COMPANION_PACKAGE = "ca.skofo.phonecontrol"
  const val AUTHORITY = "ca.skofo.phonecontrol.status"
  const val STATE_PATH = "state"

  /** SHA-256 of the owner's phone-control release signing certificate. */
  const val COMPANION_CERT_SHA256 = "f85ee546a3f335aa3c86965260ce7ad0e0ef74f821a6e1dfc15146d086ec0489"

  fun hexToBytes(hex: String): ByteArray =
    ByteArray(hex.length / 2) { index -> hex.substring(index * 2, index * 2 + 2).toInt(16).toByte() }

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
