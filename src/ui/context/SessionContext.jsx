import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import { decodeJwtPayload, isAccessTokenValid } from "../utils/accessToken";

const SessionContext = createContext();
const USER_STORAGE_KEY = "user";
const TOKEN_STORAGE_KEY = "token";
const SESSION_META_STORAGE_KEY = "vt:appSession";
const REQUIRE_LOCAL_APP_LOGIN_KEY = "vt:requireLocalAppLogin";
const LEGACY_FIXED_APP_PHONE = "000";
const APP_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const getSessionStorage = () => {
  if (typeof window === "undefined") return null;
  return window.sessionStorage || null;
};

const getLocalStorage = () => {
  if (typeof window === "undefined") return null;
  return window.localStorage || null;
};

const safeRemove = (storage, key) => {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch (error) {
    console.warn(`Failed to remove ${key} from storage`, error);
  }
};

const safeSet = (storage, key, value) => {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch (error) {
    console.warn(`Failed to persist ${key} in storage`, error);
  }
};

const getTokenTimestampMs = (token, claim) => {
  const payload = decodeJwtPayload(token);
  const value = Number(payload?.[claim]);
  return Number.isFinite(value) && value > 0 ? value * 1000 : null;
};

const buildSessionMeta = (token, now = Date.now()) => {
  const issuedAt = getTokenTimestampMs(token, "iat") || now;
  const tokenExpiresAt = getTokenTimestampMs(token, "exp");
  const sessionExpiresAt = issuedAt + APP_SESSION_MAX_AGE_MS;
  return {
    issuedAt,
    expiresAt: tokenExpiresAt
      ? Math.min(tokenExpiresAt, sessionExpiresAt)
      : sessionExpiresAt,
  };
};

const readSessionMeta = (localRef, sessionRef) => {
  const raw =
    localRef?.getItem(SESSION_META_STORAGE_KEY) ||
    sessionRef?.getItem(SESSION_META_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const issuedAt = Number(parsed?.issuedAt);
    const expiresAt = Number(parsed?.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;
    return {
      issuedAt:
        Number.isFinite(issuedAt) && issuedAt > 0 ? issuedAt : expiresAt,
      expiresAt,
    };
  } catch {
    return null;
  }
};

const resolveSessionMeta = (token, existingMeta = null, now = Date.now()) => {
  const tokenMeta = buildSessionMeta(token, now);
  if (!existingMeta) return tokenMeta;
  return {
    issuedAt: existingMeta.issuedAt || tokenMeta.issuedAt,
    expiresAt: Math.min(existingMeta.expiresAt, tokenMeta.expiresAt),
  };
};

const isSessionMetaValid = (meta, now = Date.now()) =>
  Boolean(meta?.expiresAt && meta.expiresAt > now);

const persistSessionMeta = (localRef, sessionRef, meta) => {
  if (!meta) return;
  safeSet(localRef, SESSION_META_STORAGE_KEY, JSON.stringify(meta));
  safeRemove(sessionRef, SESSION_META_STORAGE_KEY);
};

const persistAuthKeys = (localRef, sessionRef, userJson, tokenValue) => {
  if (userJson != null) {
    safeSet(localRef, USER_STORAGE_KEY, userJson);
    safeRemove(sessionRef, USER_STORAGE_KEY);
  }
  if (tokenValue != null) {
    safeSet(localRef, TOKEN_STORAGE_KEY, tokenValue);
    safeRemove(sessionRef, TOKEN_STORAGE_KEY);
  }
};

const clearAllAuthKeys = (localRef, sessionRef) => {
  safeRemove(localRef, USER_STORAGE_KEY);
  safeRemove(localRef, TOKEN_STORAGE_KEY);
  safeRemove(localRef, SESSION_META_STORAGE_KEY);
  safeRemove(sessionRef, USER_STORAGE_KEY);
  safeRemove(sessionRef, TOKEN_STORAGE_KEY);
  safeRemove(sessionRef, SESSION_META_STORAGE_KEY);
};

const normalizeUserForSession = (userData) => {
  if (!userData || typeof userData !== "object") return null;
  return userData;
};

const isLegacyFixedGuestSession = (userData) =>
  Boolean(userData?.guest) &&
  (String(userData?.phone || "").trim() === LEGACY_FIXED_APP_PHONE ||
    String(userData?.id || "").trim() === LEGACY_FIXED_APP_PHONE);

export const useSession = () => {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error("useSession must be used within SessionProvider");
  }
  return context;
};

export const SessionProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isGuest, setIsGuest] = useState(false);
  const [sessionHydrated, setSessionHydrated] = useState(false);
  const [authBootstrapPending, setAuthBootstrapPending] = useState(false);
  const [blockSilentGuest, setBlockSilentGuest] = useState(false);
  const [sessionExpiresAt, setSessionExpiresAt] = useState(null);

  const clearPersistedRefreshToken = useCallback(async () => {
    if (!window?.electronAPI?.clearRefreshToken) return;

    const env =
      typeof process !== "undefined" && process.env ? process.env : {};
    const candidateBaseUrls = [
      env.BACKEND_URL,
      env.REACT_APP_BACKEND_URL,
      "http://localhost:3001",
      "http://127.0.0.1:3001",
    ].filter(Boolean);

    const uniqueBaseUrls = Array.from(new Set(candidateBaseUrls));
    await Promise.allSettled(
      uniqueBaseUrls.map((baseUrl) =>
        window.electronAPI.clearRefreshToken({
          baseUrl,
          name: "refreshToken",
        }),
      ),
    );
  }, []);

  const clearCurrentSession = useCallback(
    (requireLocalAppLogin = true) => {
      const localRef = getLocalStorage();
      const sessionRef = getSessionStorage();

      setToken(null);
      setUser(null);
      setIsGuest(false);
      setSessionExpiresAt(null);
      setBlockSilentGuest(requireLocalAppLogin);
      clearAllAuthKeys(localRef, sessionRef);

      if (requireLocalAppLogin) {
        safeSet(localRef, REQUIRE_LOCAL_APP_LOGIN_KEY, "1");
        safeSet(sessionRef, REQUIRE_LOCAL_APP_LOGIN_KEY, "1");
      } else {
        safeRemove(localRef, REQUIRE_LOCAL_APP_LOGIN_KEY);
        safeRemove(sessionRef, REQUIRE_LOCAL_APP_LOGIN_KEY);
      }

      void clearPersistedRefreshToken();
    },
    [clearPersistedRefreshToken],
  );

  useEffect(() => {
    const sessionRef = getSessionStorage();
    const localRef = getLocalStorage();

    const requireLocalAppLogin =
      localRef?.getItem(REQUIRE_LOCAL_APP_LOGIN_KEY) === "1" ||
      sessionRef?.getItem(REQUIRE_LOCAL_APP_LOGIN_KEY) === "1";

    if (requireLocalAppLogin) {
      clearAllAuthKeys(localRef, sessionRef);
      setUser(null);
      setIsGuest(false);
      setToken(null);
      setSessionExpiresAt(null);
      setBlockSilentGuest(true);
      void clearPersistedRefreshToken();
      setIsLoading(false);
      return;
    }

    const savedUserJson =
      localRef?.getItem(USER_STORAGE_KEY) ||
      sessionRef?.getItem(USER_STORAGE_KEY);
    const savedToken =
      localRef?.getItem(TOKEN_STORAGE_KEY) ||
      sessionRef?.getItem(TOKEN_STORAGE_KEY);

    const hasValidSavedToken =
      savedToken &&
      savedToken !== "undefined" &&
      savedToken !== "null" &&
      isAccessTokenValid(savedToken);
    const savedSessionMeta = hasValidSavedToken
      ? resolveSessionMeta(savedToken, readSessionMeta(localRef, sessionRef))
      : null;
    const hasValidSavedSession = isSessionMetaValid(savedSessionMeta);

    if (hasValidSavedToken && hasValidSavedSession && savedUserJson) {
      let parsedUser = null;
      try {
        parsedUser = normalizeUserForSession(JSON.parse(savedUserJson));
      } catch (e) {
        console.error("Failed to parse saved user:", e);
        safeRemove(localRef, USER_STORAGE_KEY);
        safeRemove(sessionRef, USER_STORAGE_KEY);
      }

      if (parsedUser && !isLegacyFixedGuestSession(parsedUser)) {
        setToken(savedToken);
        setUser(parsedUser);
        setIsGuest(Boolean(parsedUser?.guest));
        setSessionExpiresAt(savedSessionMeta.expiresAt);
        setBlockSilentGuest(false);
        persistAuthKeys(localRef, sessionRef, savedUserJson, savedToken);
        persistSessionMeta(localRef, sessionRef, savedSessionMeta);
      } else {
        clearAllAuthKeys(localRef, sessionRef);
        setToken(null);
        setUser(null);
        setIsGuest(false);
        setSessionExpiresAt(null);
        setBlockSilentGuest(true);
        void clearPersistedRefreshToken();
      }
    } else {
      clearAllAuthKeys(localRef, sessionRef);
      setToken(null);
      setUser(null);
      setIsGuest(false);
      setSessionExpiresAt(null);
      setBlockSilentGuest(true);
      if (savedToken || savedUserJson) {
        void clearPersistedRefreshToken();
      }
    }

    setIsLoading(false);
  }, [clearPersistedRefreshToken]);

  useEffect(() => {
    if (isLoading) return;

    const hasActiveSession =
      sessionExpiresAt && sessionExpiresAt > Date.now();

    if (token && isAccessTokenValid(token) && hasActiveSession) {
      setSessionHydrated(true);
      setAuthBootstrapPending(false);
      return;
    }

    setSessionHydrated(true);
    setAuthBootstrapPending(false);
  }, [isLoading, token, sessionExpiresAt, blockSilentGuest]);

  useEffect(() => {
    if (isLoading || !sessionExpiresAt) return undefined;

    const remainingMs = sessionExpiresAt - Date.now();
    if (remainingMs <= 0) {
      clearCurrentSession(true);
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      clearCurrentSession(true);
    }, remainingMs);

    return () => window.clearTimeout(timeoutId);
  }, [clearCurrentSession, isLoading, sessionExpiresAt]);

  const login = (userData, accessToken) => {
    const localRef = getLocalStorage();
    const sessionRef = getSessionStorage();
    const normalizedUser = normalizeUserForSession(userData);

    setUser(normalizedUser);
    setIsGuest(Boolean(normalizedUser?.guest));

    if (accessToken) {
      safeRemove(localRef, REQUIRE_LOCAL_APP_LOGIN_KEY);
      safeRemove(sessionRef, REQUIRE_LOCAL_APP_LOGIN_KEY);
      setToken(accessToken);
      const sessionMeta = buildSessionMeta(accessToken);
      setSessionExpiresAt(sessionMeta.expiresAt);
      setBlockSilentGuest(false);
      persistAuthKeys(
        localRef,
        sessionRef,
        JSON.stringify(normalizedUser),
        accessToken,
      );
      persistSessionMeta(localRef, sessionRef, sessionMeta);
    } else {
      setToken(null);
      setSessionExpiresAt(null);
      persistAuthKeys(
        localRef,
        sessionRef,
        JSON.stringify(normalizedUser),
        null,
      );
      safeRemove(localRef, TOKEN_STORAGE_KEY);
      safeRemove(sessionRef, TOKEN_STORAGE_KEY);
      safeRemove(localRef, SESSION_META_STORAGE_KEY);
      safeRemove(sessionRef, SESSION_META_STORAGE_KEY);
    }
  };

  const logout = useCallback(() => {
    clearCurrentSession(true);
  }, [clearCurrentSession]);

  const updateUser = (userData) => {
    const localRef = getLocalStorage();
    const sessionRef = getSessionStorage();
    const normalizedUser = normalizeUserForSession(userData);

    setUser(normalizedUser);
    setIsGuest(Boolean(normalizedUser?.guest));
    persistAuthKeys(localRef, sessionRef, JSON.stringify(normalizedUser), null);
  };

  const hasActiveSession = Boolean(
    sessionExpiresAt && sessionExpiresAt > Date.now(),
  );

  return (
    <SessionContext.Provider
      value={{
        user,
        token,
        isLoading,
        sessionHydrated,
        authBootstrapPending,
        login,
        logout,
        updateUser,
        sessionExpiresAt,
        isAuthenticated: Boolean(
          user && token && isAccessTokenValid(token) && hasActiveSession,
        ),
        isGuest,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
};

export default SessionContext;
