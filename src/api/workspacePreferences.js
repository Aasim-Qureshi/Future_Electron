import httpClient from "./httpClient";

/** @param {{ ramTabsPerGb: number | null }} body */
export const patchWorkspacePreferences = (body) =>
  httpClient.patch("/users/workspace-preferences", body);
