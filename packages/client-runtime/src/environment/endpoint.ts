export * from "@t3tools/shared/advertisedEndpoint";

import { urlUnderBase } from "@t3tools/shared/basePath";

/** `pathname` on the environment, under its base path (a linked environment's relay). */
export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string =>
  urlUnderBase(httpBaseUrl, pathname).toString();
