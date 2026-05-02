import httpClient from "./httpClient";

export const fetchUploadStatsFromApi = () => httpClient.get("/users/upload-stats");

export const recordUploadStatRemote = (body) =>
  httpClient.post("/users/upload-stats/record", body);

export const clearUploadStatsRemote = () => httpClient.delete("/users/upload-stats");
