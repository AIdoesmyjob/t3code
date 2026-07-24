import type {
  AssetCreateUrlResult,
  AssetResource,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import { AsyncResult } from "effect/unstable/reactivity";

import { resolveAssetUrl } from "~/assets/assetUrls";

export class WorkspaceDownloadUrlError extends Data.TaggedError("WorkspaceDownloadUrlError")<{
  readonly message: string;
}> {}

export type CreateAssetUrlMutation<E = unknown> = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly resource: AssetResource };
}) => Promise<AtomCommandResult<AssetCreateUrlResult, E>>;

export function triggerBrowserDownload(url: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
}

export async function downloadWorkspaceFile<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: CreateAssetUrlMutation<E>;
  readonly triggerDownload?: (url: string) => void;
}): Promise<AtomCommandResult<void, E | WorkspaceDownloadUrlError>> {
  const assetResult = await input.createAssetUrl({
    environmentId: input.threadRef.environmentId,
    input: {
      resource: {
        _tag: "workspace-download",
        threadId: input.threadRef.threadId,
        path: input.filePath,
      },
    },
  });
  if (assetResult._tag === "Failure") {
    return AsyncResult.failure(assetResult.cause);
  }

  const assetUrl = resolveAssetUrl(input.httpBaseUrl, assetResult.value.relativeUrl);
  if (assetUrl === null) {
    return AsyncResult.failure(
      Cause.fail(
        new WorkspaceDownloadUrlError({
          message: "The environment returned an invalid download URL.",
        }),
      ),
    );
  }

  (input.triggerDownload ?? triggerBrowserDownload)(assetUrl);
  return AsyncResult.success(undefined);
}
