import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { io } from "socket.io-client";
import { useSession } from "./SessionContext";

const NotificationContext = createContext(null);
const SOCKET_URL =
  (typeof process !== "undefined" && process?.env?.REACT_APP_BACKEND_URL) ||
  (typeof process !== "undefined" && process?.env?.BACKEND_URL) ||
  "http://localhost:3000";
const DEFAULT_LIMIT = 12;
const MAX_BUFFER = 50;
const POLL_INTERVAL_MS = 15000;

export const useNotifications = () => {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error(
      "useNotifications must be used within NotificationProvider",
    );
  }
  return ctx;
};

export const NotificationProvider = ({ children }) => {
  const { user, token, isAuthenticated, isGuest } = useSession();
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [socketToken, setSocketToken] = useState("");
  const [socketStatus, setSocketStatus] = useState("disconnected");
  const pollRef = useRef(null);
  const headers = useMemo(
    () => (token ? { Authorization: `Bearer ${token}` } : {}),
    [token],
  );

  const refreshNotifications = useCallback(
    async (limit = DEFAULT_LIMIT) => {
      if (isGuest || !window?.electronAPI?.apiRequest || !token) return;
      setLoading(true);
      try {
        const data = await window.electronAPI.apiRequest(
          "GET",
          `/api/notifications?limit=${limit}`,
          {},
          headers,
        );
        const items = Array.isArray(data?.notifications)
          ? data.notifications
          : [];
        setNotifications(items);
        if (Number.isFinite(data?.unreadCount)) {
          setUnreadCount(data.unreadCount);
        } else {
          setUnreadCount(items.filter((item) => !item.readAt).length);
        }
      } catch (err) {
        console.error("Failed to load notifications", err);
      } finally {
        setLoading(false);
      }
    },
    [headers, isGuest, token],
  );

  const markNotificationRead = useCallback(
    async (id) => {
      if (isGuest || !window?.electronAPI?.apiRequest || !token || !id) return;
      try {
        const data = await window.electronAPI.apiRequest(
          "PATCH",
          `/api/notifications/${id}/read`,
          {},
          headers,
        );
        const updated = data?.notification;
        setNotifications((prev) =>
          prev.map((item) =>
            item._id === id
              ? {
                  ...item,
                  readAt:
                    updated?.readAt || item.readAt || new Date().toISOString(),
                }
              : item,
          ),
        );
        setUnreadCount((prev) => Math.max(0, prev - 1));
      } catch (err) {
        console.error("Failed to mark notification read", err);
      }
    },
    [headers, isGuest, token],
  );

  const markAllRead = useCallback(async () => {
    if (isGuest || !window?.electronAPI?.apiRequest || !token) return;
    try {
      await window.electronAPI.apiRequest(
        "POST",
        "/api/notifications/read-all",
        {},
        headers,
      );
      setNotifications((prev) =>
        prev.map((item) => ({
          ...item,
          readAt: item.readAt || new Date().toISOString(),
        })),
      );
      setUnreadCount(0);
    } catch (err) {
      console.error("Failed to mark notifications read", err);
    }
  }, [headers, isGuest, token]);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(() => {
      refreshNotifications();
    }, POLL_INTERVAL_MS);
  }, [refreshNotifications]);

  const stopPolling = useCallback(() => {
    if (!pollRef.current) return;
    clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  useEffect(() => {
    if (!isAuthenticated || isGuest) {
      setNotifications([]);
      setUnreadCount(0);
      stopPolling();
      return;
    }
    refreshNotifications();
  }, [isAuthenticated, isGuest, refreshNotifications, stopPolling]);

  useEffect(() => {
    if (isGuest) {
      setSocketToken("");
      return;
    }
    if (token) {
      setSocketToken(token);
      return;
    }
    if (!window?.electronAPI?.getToken) return;
    window.electronAPI.getToken().then((res) => {
      if (res?.token) {
        setSocketToken(res.token);
      }
    });
  }, [isGuest, token]);

  useEffect(() => {
    if (isGuest || !socketToken || !user) return;
    const socket = io(SOCKET_URL, {
      auth: { token: socketToken },
    });

    socket.on("connect", () => {
      setSocketStatus("connected");
      refreshNotifications();
    });
    socket.on("disconnect", () => setSocketStatus("disconnected"));
    socket.on("connect_error", () => setSocketStatus("error"));

    socket.on("notification:new", (payload) => {
      if (!payload?._id) return;
      setNotifications((prev) => {
        if (prev.some((item) => item._id === payload._id)) return prev;
        return [payload, ...prev].slice(0, MAX_BUFFER);
      });
      if (!payload.readAt) {
        setUnreadCount((prev) => prev + 1);
      }
    });

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("connect_error");
      socket.off("notification:new");
      socket.disconnect();
    };
  }, [isGuest, socketToken, user, refreshNotifications]);

  useEffect(() => {
    if (!isAuthenticated || isGuest) return;
    if (socketStatus === "connected") {
      stopPolling();
    } else {
      startPolling();
    }
  }, [isAuthenticated, isGuest, socketStatus, startPolling, stopPolling]);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        unreadCount,
        loading,
        refreshNotifications,
        markNotificationRead,
        markAllRead,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
};

export default NotificationContext;
