import React, { useCallback, useMemo, useState } from "react";
import { Lock } from "lucide-react";
import { useSession } from "../context/SessionContext";
import { isAccessTokenValid } from "../utils/accessToken";

/** في Electron renderer لا يوجد غالبًا `process` — نقرأ البيئة فقط إن وُجدت */
function envString(key, fallback) {
  try {
    if (
      typeof process !== "undefined" &&
      process.env &&
      process.env[key] != null
    ) {
      const v = String(process.env[key]).trim();
      if (v !== "") return v;
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

const readExpected = () => ({
  username: envString("REACT_APP_APP_LOGIN_USERNAME", "000"),
  password: envString("REACT_APP_APP_LOGIN_PASSWORD", "000"),
});

/**
 * قفل التطبيق المحلي (ليست Taqeem): يظهر فقط عندما لا يوجد توكن وصول صالح.
 * أثناء التحميل/ضيف bootstrap لا يظهر الفورم لتفادي الوميض.
 */
export function LocalAppLoginGate({ children }) {
  const {
    token,
    sessionHydrated,
    authBootstrapPending,
    bootstrapGuestSession,
    isLoading,
  } = useSession();
  const expected = useMemo(() => readExpected(), []);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = useCallback(
    async (e) => {
      e.preventDefault();
      setError("");
      const u = username.trim();
      const p = password;
      if (u !== expected.username || p !== expected.password) {
        setError("اسم المستخدم أو الرقم السري غير صحيح");
        return;
      }
      setSubmitting(true);
      try {
        const access = await bootstrapGuestSession();
        if (!access || !isAccessTokenValid(access)) {
          setError("تعذر تجديد الجلسة. تحقق من الاتصال بالخادم.");
        }
      } catch (err) {
        setError(err?.message || "فشل تسجيل الدخول");
      } finally {
        setSubmitting(false);
      }
    },
    [username, password, expected.password, expected.username, bootstrapGuestSession],
  );

  if (isLoading || !sessionHydrated || authBootstrapPending) {
    return (
      <div
        className="fixed inset-0 z-[9998] flex items-center justify-center bg-slate-950"
        aria-busy="true"
        aria-label="جاري تحميل الجلسة"
      />
    );
  }

  if (!isAccessTokenValid(token)) {
    return (
      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950 px-4"
        dir="rtl"
      >
        <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-xl">
          <div className="mb-6 flex flex-col items-center gap-2 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-cyan-500/20 text-cyan-300">
              <Lock className="h-6 w-6" />
            </span>
            <h1 className="text-lg font-bold text-white">تسجيل دخول التطبيق</h1>
            <p className="text-xs text-slate-400">
              يظهر تلقائياً عند انتهاء صلاحية جلسة التطبيق (توكن الوصول، عادة
              24 ساعة). أدخل بيانات البيئة ثم يُجدَّد الاتصال بالخادم.
            </p>
          </div>
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <label className="text-xs font-medium text-slate-300">
              اسم المستخدم
              <input
                type="text"
                autoComplete="username"
                value={username}
                onChange={(ev) => setUsername(ev.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500"
              />
            </label>
            <label className="text-xs font-medium text-slate-300">
              الرقم السري
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(ev) => setPassword(ev.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500"
              />
            </label>
            {error ? (
              <p className="text-center text-xs text-rose-400">{error}</p>
            ) : null}
            <button
              type="submit"
              disabled={submitting}
              className="mt-2 rounded-lg bg-cyan-600 py-2.5 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-60"
            >
              {submitting ? "جاري الدخول…" : "دخول"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return children;
}

export default LocalAppLoginGate;
