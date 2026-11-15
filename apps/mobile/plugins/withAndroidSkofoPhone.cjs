const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

// skofo: long-press power opens T3 as the digital assistant, and the "This phone" card may see
// the phone-control companion. The assistant activity lives in modules/t3-phone-control.

const ASSIST_ACTIVITY = "expo.modules.t3phonecontrol.AssistActivity";
const COMPANION_PACKAGE = "ca.skofo.phonecontrol";

function applySkofoPhoneManifest(manifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  application.activity = (application.activity ?? []).filter(
    (activity) => activity.$["android:name"] !== ASSIST_ACTIVITY,
  );
  application.activity.push({
    $: {
      "android:name": ASSIST_ACTIVITY,
      "android:exported": "true",
      "android:excludeFromRecents": "true",
      "android:noHistory": "false",
      "android:taskAffinity": "",
      "android:theme": "@android:style/Theme.Translucent.NoTitleBar",
    },
    "intent-filter": [
      {
        action: [{ $: { "android:name": "android.intent.action.ASSIST" } }],
        category: [{ $: { "android:name": "android.intent.category.DEFAULT" } }],
      },
    ],
  });
  const queries = (manifest.manifest.queries ??= [{}]);
  const query = queries[0];
  const packages = (query.package ??= []);
  if (!packages.some((entry) => entry.$["android:name"] === COMPANION_PACKAGE)) {
    packages.push({ $: { "android:name": COMPANION_PACKAGE } });
  }
  return manifest;
}

module.exports = function withAndroidSkofoPhone(config) {
  return withAndroidManifest(config, (nextConfig) => {
    applySkofoPhoneManifest(nextConfig.modResults);
    return nextConfig;
  });
};
module.exports.applySkofoPhoneManifest = applySkofoPhoneManifest;
