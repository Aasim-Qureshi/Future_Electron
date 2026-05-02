import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import { isAccessTokenValid } from "../utils/accessToken";

const SessionContext = createContext();
const USER_STORAGE_KEY = "user";
const TOKEN_STORAGE_KEY = "token";
/** رقم المستخدم المحلي الثابت في التطبيق (ليس "ضيفًا" من واجهة المستخدم) */
export const LOCAL_APP_USER_PHONE = "000";
const LOCAL_USER_PHONE = LOCAL_APP_USER_PHONE;
/** بعد تسجيل الخروج: لا تُستعاد جلسة الضيف تلقائيًا حتى يمرّ المستخدم بفورم الدخول المحلي */
const REQUIRE_LOCAL_APP_LOGIN_KEY = "vt:requireLocalAppLogin";

const buildLocalSingleUser = () => ({
  id: LOCAL_USER_PHONE,
  phone: LOCAL_USER_PHONE,
  guest: true,
});

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

/** Auth survives Electron restarts: primary store is localStorage; sessionStorage is legacy. */
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
  safeRemove(sessionRef, USER_STORAGE_KEY);
  safeRemove(sessionRef, TOKEN_STORAGE_KEY);
};

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

  const clearPersistedRefreshToken = async () => {
    if (!window?.electronAPI?.clearRefreshToken) return;

    const env =
      typeof process !== "undefined" && process.env ? process.env : {};
    const candidateBaseUrls = [
      env.BACKEND_URL,
      env.REACT_APP_BACKEND_URL,
      "http://localhost:3000",
      "http://127.0.0.1:3000",
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
  };

  const bootstrapGuestSession = useCallback(async () => {
    if (!window?.electronAPI?.apiRequest) return null;
    const result = await window.electronAPI.apiRequest(
      "POST",
      "/api/users/guest",
      {},
      {},
    );
    const access = result?.token || result?.refreshToken;
    const apiUser = result?.user;
    const localRef = getLocalStorage();
    const sessionRef = getSessionStorage();
    if (access) {
      safeRemove(localRef, REQUIRE_LOCAL_APP_LOGIN_KEY);
      safeRemove(sessionRef, REQUIRE_LOCAL_APP_LOGIN_KEY);
      setToken(access);
      setBlockSilentGuest(false);
      persistAuthKeys(localRef, sessionRef, null, access);
    }
    if (apiUser && typeof apiUser === "object") {
      const merged = {
        ...apiUser,
        phone: LOCAL_USER_PHONE,
        guest: true,
      };
      setUser(merged);
      persistAuthKeys(localRef, sessionRef, JSON.stringify(merged), null);
    }
    return access || null;
  }, []);

  useEffect(() => {
    const sessionRef = getSessionStorage();
    const localRef = getLocalStorage();

    const requireLocalAppLogin =
      localRef?.getItem(REQUIRE_LOCAL_APP_LOGIN_KEY) === "1" ||
      sessionRef?.getItem(REQUIRE_LOCAL_APP_LOGIN_KEY) === "1";

    if (requireLocalAppLogin) {
      safeRemove(localRef, USER_STORAGE_KEY);
      safeRemove(sessionRef, USER_STORAGE_KEY);
      safeRemove(localRef, TOKEN_STORAGE_KEY);
      safeRemove(sessionRef, TOKEN_STORAGE_KEY);
      setUser(null);
      setIsGuest(false);
      setToken(null);
      setBlockSilentGuest(true);
      setIsLoading(false);
      return;
    }

    const savedUserJson =
      localRef?.getItem(USER_STORAGE_KEY) ||
      sessionRef?.getItem(USER_STORAGE_KEY);
    let savedToken =
      localRef?.getItem(TOKEN_STORAGE_KEY) ||
      sessionRef?.getItem(TOKEN_STORAGE_KEY);

    let restoredUser = false;

    if (savedUserJson) {
      try {
        const parsed = JSON.parse(savedUserJson);
        if (typeof parsed === "string") {
          setUser({ ...buildLocalSingleUser(), id: parsed });
          setIsGuest(true);
        } else {
          setUser(parsed);
          const guestish =
            Boolean(parsed?.guest) ||
            !parsed?.phone ||
            String(parsed.phone) === LOCAL_USER_PHONE;
          setIsGuest(guestish);
        }
        restoredUser = true;
        persistAuthKeys(localRef, sessionRef, savedUserJson, null);
      } catch (e) {
        console.error("Failed to parse saved user:", e);
        safeRemove(localRef, USER_STORAGE_KEY);
        safeRemove(sessionRef, USER_STORAGE_KEY);
      }
    }

    if (!restoredUser) {
      const local = buildLocalSingleUser();
      setUser(local);
      setIsGuest(true);
      persistAuthKeys(localRef, sessionRef, JSON.stringify(local), null);
    }

    if (savedToken && savedToken !== "undefined" && savedToken !== "null") {
      if (isAccessTokenValid(savedToken)) {
        setToken(savedToken);
        persistAuthKeys(localRef, sessionRef, null, savedToken);
      } else {
        setBlockSilentGuest(true);
        safeRemove(localRef, TOKEN_STORAGE_KEY);
        safeRemove(sessionRef, TOKEN_STORAGE_KEY);
        setToken(null);
      }
    }

    setIsLoading(false);
  }, []);

  useEffect(() => {
    if (isLoading) return;

    let cancelled = false;

    (async () => {
      if (blockSilentGuest && !token) {
        setSessionHydrated(true);
        setAuthBootstrapPending(false);
        return;
      }

      if (token && isAccessTokenValid(token)) {
        setSessionHydrated(true);
        setAuthBootstrapPending(false);
        return;
      }

      if (!window?.electronAPI?.apiRequest) {
        setSessionHydrated(true);
        setAuthBootstrapPending(false);
        return;
      }

      setAuthBootstrapPending(true);
      try {
        await bootstrapGuestSession();
      } catch (err) {
        console.warn("[Session] guest bootstrap skipped:", err?.message || err);
      } finally {
        if (!cancelled) {
          setAuthBootstrapPending(false);
          setSessionHydrated(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLoading, token, bootstrapGuestSession, blockSilentGuest]);

  const login = (userData, accessToken) => {
    const localRef = getLocalStorage();
    const sessionRef = getSessionStorage();

    let normalizedUser = userData;
    let guestFlag = false;

    if (typeof userData === "string") {
      normalizedUser = { id: userData, guest: true };
      guestFlag = true;
    } else if (userData?.guest) {
      guestFlag = true;
    }

    setUser(normalizedUser);
    setIsGuest(guestFlag);

    if (accessToken) {
      safeRemove(localRef, REQUIRE_LOCAL_APP_LOGIN_KEY);
      safeRemove(sessionRef, REQUIRE_LOCAL_APP_LOGIN_KEY);
      setToken(accessToken);
      setBlockSilentGuest(false);
      persistAuthKeys(
        localRef,
        sessionRef,
        JSON.stringify(normalizedUser),
        accessToken,
      );
    } else {
      setToken(null);
      persistAuthKeys(
        localRef,
        sessionRef,
        JSON.stringify(normalizedUser),
        null,
      );
      safeRemove(localRef, TOKEN_STORAGE_KEY);
      safeRemove(sessionRef, TOKEN_STORAGE_KEY);
    }
  };

  const logout = () => {
    const localRef = getLocalStorage();
    const sessionRef = getSessionStorage();

    setToken(null);
    setUser(null);
    setIsGuest(false);
    setBlockSilentGuest(true);
    clearAllAuthKeys(localRef, sessionRef);
    safeSet(localRef, REQUIRE_LOCAL_APP_LOGIN_KEY, "1");
    safeSet(sessionRef, REQUIRE_LOCAL_APP_LOGIN_KEY, "1");
    void clearPersistedRefreshToken();
  };

  const updateUser = (userData) => {
    const localRef = getLocalStorage();
    const sessionRef = getSessionStorage();

    setUser(userData);
    setIsGuest(Boolean(userData?.guest));
    persistAuthKeys(localRef, sessionRef, JSON.stringify(userData), null);
  };

  return (
    <SessionContext.Provider
      value={{
        user,
        token,
        isLoading,
        sessionHydrated,
        authBootstrapPending,
        bootstrapGuestSession,
        login,
        logout,
        updateUser,
        isAuthenticated: !!user,
        isGuest,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
};

export default SessionContext;
