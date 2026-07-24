import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { downloadWorkspaceFile } from "./downloadWorkspaceFile";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("downloadWorkspaceFile", () => {
  it("requests an authenticated workspace download and triggers it", async () => {
    const createAssetUrl = vi.fn(async () =>
      AsyncResult.success({
        relativeUrl: "/api/assets/signed-token/brochure.pdf",
        expiresAt: Date.now() + 60_000,
      }),
    );
    const triggerDownload = vi.fn();

    const result = await downloadWorkspaceFile({
      threadRef: THREAD_REF,
      filePath: "/workspace/brochure.pdf",
      httpBaseUrl: "https://environment.example/base/",
      createAssetUrl,
      triggerDownload,
    });

    expect(result._tag).toBe("Success");
    expect(createAssetUrl).toHaveBeenCalledWith({
      environmentId: THREAD_REF.environmentId,
      input: {
        resource: {
          _tag: "workspace-download",
          threadId: THREAD_REF.threadId,
          path: "/workspace/brochure.pdf",
        },
      },
    });
    expect(triggerDownload).toHaveBeenCalledWith(
      "https://environment.example/api/assets/signed-token/brochure.pdf",
    );
  });

  it("does not trigger a download for an invalid asset URL", async () => {
    const triggerDownload = vi.fn();
    const result = await downloadWorkspaceFile({
      threadRef: THREAD_REF,
      filePath: "/workspace/brochure.pdf",
      httpBaseUrl: "not a URL",
      createAssetUrl: async () =>
        AsyncResult.success({
          relativeUrl: "/api/assets/signed-token/brochure.pdf",
          expiresAt: Date.now() + 60_000,
        }),
      triggerDownload,
    });

    expect(result._tag).toBe("Failure");
    expect(triggerDownload).not.toHaveBeenCalled();
  });
});
