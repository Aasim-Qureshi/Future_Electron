// main process - packageHandlers.js
const { ipcMain, session } = require("electron");
const axios = require("axios");
const process = require("process");

const AUTH_EXPIRED_CHANNEL = "auth-expired";

const isAuthExpired = (status, message) => {
  const code = Number(status || 0);
  if ([401, 403, 419].includes(code)) return true;
  const text = String(message || "").toLowerCase();
  return (
    text.includes("expired token") ||
    text.includes("token expired") ||
    text.includes("session expired") ||
    text.includes("please login")
  );
};

const notifyAuthExpired = (event, status, message) => {
  if (!event?.sender?.send) return;
  if (!isAuthExpired(status, message)) return;
  try {
    event.sender.send(AUTH_EXPIRED_CHANNEL, { status, message });
  } catch (err) {
    console.warn("[API] Failed to notify auth-expired", err);
  }
};

const parseSetCookieString = (cookieStr) => {
  const parts = cookieStr.split(";").map((p) => p.trim());
  const [nameValue, ...attrs] = parts;
  const [name, ...valParts] = nameValue.split("=");
  const value = valParts.join("=");

  const parsed = { name, value };

  attrs.forEach((attr) => {
    const [k, ...vParts] = attr.split("=");
    const key = k.trim().toLowerCase();
    const v = vParts.join("=").trim();
    if (key === "httponly") parsed.httpOnly = true;
    else if (key === "secure") parsed.secure = true;
    else if (key === "samesite") parsed.sameSite = v.toLowerCase();
    else if (key === "path") parsed.path = v;
    else if (key === "domain") parsed.domain = v;
    else if (key === "expires")
      parsed.expires = new Date(v).getTime() / 1000; // seconds
    else if (key === "max-age") parsed.maxAge = Number(v);
  });

  return parsed;
};

const setElectronCookieForBaseUrl = async (baseUrl, cookieObj) => {
  // cookieObj: { name, value, domain?, path?, httpOnly?, secure?, sameSite?, expires?, maxAge? }
  let cookieUrl = baseUrl;
  if (!/^https?:\/\//i.test(cookieUrl)) {
    cookieUrl = `http://${cookieUrl}`;
  }

  const cookieToSet = {
    url: cookieUrl,
    name: cookieObj.name,
    value: cookieObj.value,
    path: cookieObj.path || "/",
    httpOnly: !!cookieObj.httpOnly,
    secure: !!cookieObj.secure,
    sameSite:
      cookieObj.sameSite === "strict"
        ? "strict"
        : cookieObj.sameSite === "lax"
          ? "lax"
          : "no_restriction",
  };

  // compute expirationDate (seconds since epoch) if possible
  if (cookieObj.expires) {
    cookieToSet.expirationDate = Number(cookieObj.expires);
  } else if (cookieObj.maxAge) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    cookieToSet.expirationDate = nowSeconds + Number(cookieObj.maxAge);
  }

  try {
    await session.defaultSession.cookies.set(cookieToSet);
    console.log(
      "[Cookies] Set cookie:",
      cookieToSet.name,
      "for",
      cookieToSet.url,
    );
  } catch (err) {
    console.warn("[Cookies] Failed to set cookie", err);
  }
};

/** Max-Age (seconds) for refresh cookie when mirroring body.refreshToken (align with backend default). */
const REFRESH_TOKEN_MAX_AGE_SEC =
  (() => {
    const d = Number(process.env.REFRESH_COOKIE_DAYS);
    const days = Number.isFinite(d) && d > 0 ? d : 365 * 100;
    return days * 24 * 60 * 60;
  })();

async function buildCookieHeaderForUrl(fullUrl) {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: fullUrl });
    if (!Array.isArray(cookies) || cookies.length === 0) return "";
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

const packageHandlers = {
  async handleApiRequest(event, requestData) {
    if (!requestData || typeof requestData !== "object") {
      throw new Error(
        "Invalid request data: expected object with method, url, data, and headers",
      );
    }

    const { method, url, data = {}, headers = {} } = requestData;

    if (!method || !url) {
      throw new Error("Method and URL are required for API request");
    }

    const candidates = [];
    const envUrl = process.env.BACKEND_URL;
    if (envUrl) candidates.push(envUrl.replace(/\/$/, ""));

    candidates.push(
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    );

    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

    const attemptRequest = async (baseUrl) => {
      const fullUrl = `${baseUrl}${url}`;
      const config = {
        method: method.toUpperCase(),
        url: fullUrl,
        headers: { "Content-Type": "application/json", ...headers },
        data,
        timeout: 10000,
        validateStatus: () => true,
      };

      console.log(`[API] Attempting ${config.method} ${config.url}`);
      let response = await axios(config);

      // Handle Set-Cookie headers
      const setCookieHeader =
        response.headers?.["set-cookie"] || response.headers?.["Set-Cookie"];
      if (setCookieHeader) {
        const cookieStrings = Array.isArray(setCookieHeader)
          ? setCookieHeader
          : [setCookieHeader];
        for (const cookieStr of cookieStrings) {
          try {
            const parsed = parseSetCookieString(cookieStr);
            await setElectronCookieForBaseUrl(baseUrl, parsed);
          } catch (err) {
            console.warn(
              "[Cookies] Could not parse/set Set-Cookie header:",
              cookieStr,
              err,
            );
          }
        }
      } else if (response.data?.refreshToken) {
        await setElectronCookieForBaseUrl(baseUrl, {
          name: "refreshToken",
          value: response.data.refreshToken,
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          path: "/",
          maxAge: REFRESH_TOKEN_MAX_AGE_SEC,
        });
      }

      if (response.status >= 200 && response.status < 300) {
        console.log(`[API] Success: ${config.method} ${config.url}`);
        return response.data;
      }

      const hadAuthHeader = Boolean(
        config.headers?.Authorization || config.headers?.authorization,
      );
      if (
        hadAuthHeader &&
        [401, 403].includes(response.status) &&
        response.data?.message
      ) {
        const cookieHeader = await buildCookieHeaderForUrl(fullUrl);
        if (cookieHeader) {
          const retryHeaders = { ...config.headers };
          delete retryHeaders.Authorization;
          delete retryHeaders.authorization;
          retryHeaders.Cookie = cookieHeader;
          const retryResponse = await axios({
            ...config,
            headers: retryHeaders,
          });

          const setCookieHeaderRetry =
            retryResponse.headers?.["set-cookie"] ||
            retryResponse.headers?.["Set-Cookie"];
          if (setCookieHeaderRetry) {
            const cookieStrings = Array.isArray(setCookieHeaderRetry)
              ? setCookieHeaderRetry
              : [setCookieHeaderRetry];
            for (const cookieStr of cookieStrings) {
              try {
                const parsed = parseSetCookieString(cookieStr);
                await setElectronCookieForBaseUrl(baseUrl, parsed);
              } catch (err) {
                console.warn(
                  "[Cookies] Could not parse/set Set-Cookie header (retry):",
                  cookieStr,
                  err,
                );
              }
            }
          } else if (retryResponse.data?.refreshToken) {
            await setElectronCookieForBaseUrl(baseUrl, {
              name: "refreshToken",
              value: retryResponse.data.refreshToken,
              httpOnly: true,
              secure: process.env.NODE_ENV === "production",
              path: "/",
              maxAge: REFRESH_TOKEN_MAX_AGE_SEC,
            });
          }

          if (retryResponse.status >= 200 && retryResponse.status < 300) {
            console.log(
              `[API] Success (cookie fallback): ${config.method} ${config.url}`,
            );
            return retryResponse.data;
          }
          response = retryResponse;
        }
      }

      let msg = response.data?.message || `HTTP ${response.status}`;
      if (
        [401, 403].includes(response.status) ||
        msg === "Invalid or expired token"
      ) {
        msg = "Please login to our system";
      }

      const err = new Error(msg);
      err.status = response.status;
      err.response = { data: response.data, headers: response.headers };
      throw err;
    };

    let lastError = null;

    for (const baseUrl of candidates) {
      try {
        return await attemptRequest(baseUrl);
      } catch (error) {
        // Retry once on ECONNREFUSED with a short delay
        if (error.code === "ECONNREFUSED") {
          console.log(
            `[API] ECONNREFUSED on ${baseUrl}${url} — retrying in 2s...`,
          );
          await sleep(2000);
          try {
            return await attemptRequest(baseUrl);
          } catch (retryError) {
            console.log(`[API] Retry also failed: ${retryError.message}`);
            error = retryError;
          }
        }

        lastError = error;
        const status = error.response?.status ?? error.status;
        const message = error.response?.data?.message || error.message;

        notifyAuthExpired(event, status, message);
        console.log(
          `[API] Failed (${status || "error"}): ${baseUrl}${url} - ${message}`,
        );

        if (status === 404) continue;

        throw error;
      }
    }

    const error = new Error(
      `No reachable backend. Last error: ${lastError?.message}`,
    );
    error.isNetworkError = true;
    throw error;
  },
};

module.exports = packageHandlers;
