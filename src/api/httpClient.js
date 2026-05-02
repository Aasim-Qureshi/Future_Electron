const axios = require("axios");

const defaultBase =
  (typeof process !== "undefined" && process?.env?.REACT_APP_BACKEND_URL) ||
  (typeof process !== "undefined" && process?.env?.BACKEND_URL) ||
  "http://localhost:3000";

const httpClient = axios.create({
  baseURL: `${String(defaultBase).replace(/\/$/, "")}/api`,
  timeout: 50000,
  headers: { "Content-Type": "application/json" },
  withCredentials: true,
});

httpClient.interceptors.request.use(async (config) => {
  const tokenObj = await window.electronAPI.getToken();
  const refreshToken = tokenObj?.refreshToken || tokenObj?.token;

  if (refreshToken) {
    config.headers["Authorization"] = `Bearer ${refreshToken}`;
  }

  return config;
});

module.exports = httpClient;
