import { describe, expect, it } from "vite-plus/test";

import withAndroidSkofoPhone from "./withAndroidSkofoPhone.cjs";

const { applySkofoPhoneManifest } = withAndroidSkofoPhone as unknown as {
  applySkofoPhoneManifest: (manifest: Manifest) => Manifest;
};

type Node = { $: Record<string, string>; [child: string]: unknown };
type Manifest = { manifest: { application: Node[]; queries?: { package?: Node[] }[] } };

function manifest(): Manifest {
  return {
    manifest: {
      application: [
        {
          $: { "android:name": ".MainApplication" },
          activity: [{ $: { "android:name": ".MainActivity" } }],
        },
      ],
    },
  };
}

function assistActivities(result: Manifest) {
  return (result.manifest.application[0]!.activity as Node[]).filter(
    (activity) => activity.$["android:name"] === "expo.modules.t3phonecontrol.AssistActivity",
  );
}

describe("withAndroidSkofoPhone", () => {
  it("declares the assistant activity for ACTION_ASSIST, out of recents", () => {
    const [assist] = assistActivities(applySkofoPhoneManifest(manifest()));
    expect(assist?.$["android:exported"]).toBe("true");
    expect(assist?.$["android:excludeFromRecents"]).toBe("true");
    expect(JSON.stringify(assist?.["intent-filter"])).toContain("android.intent.action.ASSIST");
    expect(JSON.stringify(assist?.["intent-filter"])).not.toContain("BROWSABLE");
  });

  it("can see the phone-control companion", () => {
    const result = applySkofoPhoneManifest(manifest());
    expect(result.manifest.queries?.[0]?.package?.map((entry) => entry.$["android:name"])).toEqual([
      "ca.skofo.phonecontrol",
    ]);
  });

  it("is idempotent", () => {
    const result = applySkofoPhoneManifest(applySkofoPhoneManifest(manifest()));
    expect(assistActivities(result)).toHaveLength(1);
    expect(result.manifest.queries?.[0]?.package).toHaveLength(1);
    expect(result.manifest.application[0]!.activity).toHaveLength(2);
  });
});
