import React, { useCallback, useState } from "react";
import { Lock, LogIn, Phone, UserPlus } from "lucide-react";
import { useSession } from "../context/SessionContext";
import { isAccessTokenValid } from "../utils/accessToken";

const readSessionJson = (key) => {
  try {
    const raw = window?.sessionStorage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const getAuthPayloadCarryOver = () => {
  const guestUserId = readSessionJson("taqeem:guestUserIdForLink");
  const guestTaqeemUser = readSessionJson("taqeem:guestUserForLink");
  return {
    ...(guestUserId ? { guestUserId } : {}),
    ...(guestTaqeemUser ? { guestTaqeemUser } : {}),
  };
};

export function LocalAppLoginGate({ children }) {
  const {
    token,
    sessionHydrated,
    authBootstrapPending,
    isLoading,
    login,
    isAuthenticated,
  } = useSession();

  const [mode, setMode] = useState("login");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const isRegister = mode === "register";

  const resetError = () => setError("");

  const onSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      setError("");

      const trimmedPhone = phone.trim();
      if (!trimmedPhone || !password) {
        setError("أدخل رقم الهاتف وكلمة المرور");
        return;
      }

      if (isRegister && password !== confirmPassword) {
        setError("تأكيد كلمة المرور غير مطابق");
        return;
      }

      if (!window?.electronAPI?.apiRequest) {
        setError("خدمة الاتصال بالخادم غير متاحة");
        return;
      }

      setSubmitting(true);
      try {
        const endpoint = isRegister ? "/api/users/register" : "/api/users/login";
        const body = isRegister
          ? {
              phone: trimmedPhone,
              password,
              type: "individual",
            }
          : {
              phone: trimmedPhone,
              password,
              ...getAuthPayloadCarryOver(),
            };

        const result = await window.electronAPI.apiRequest(
          "POST",
          endpoint,
          body,
          {},
        );
        const access = result?.token || result?.refreshToken;
        const apiUser = result?.user;

        if (!access || !isAccessTokenValid(access) || !apiUser) {
          setError("تمت العملية لكن لم يرجع الخادم جلسة صالحة");
          return;
        }

        login(apiUser, access);
      } catch (err) {
        const message =
          err?.response?.data?.message ||
          err?.message ||
          (isRegister ? "فشل إنشاء الحساب" : "فشل تسجيل الدخول");
        setError(message);
      } finally {
        setSubmitting(false);
      }
    },
    [confirmPassword, isRegister, login, password, phone],
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

  if (!isAuthenticated || !isAccessTokenValid(token)) {
    return (
      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950 px-4"
        dir="rtl"
      >
        <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-xl">
          <div className="mb-5 flex flex-col items-center gap-2 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-cyan-500/20 text-cyan-300">
              {isRegister ? (
                <UserPlus className="h-6 w-6" />
              ) : (
                <Lock className="h-6 w-6" />
              )}
            </span>
            <h1 className="text-lg font-bold text-white">
              {isRegister ? "إنشاء حساب جديد" : "تسجيل دخول التطبيق"}
            </h1>
            <p className="text-xs leading-5 text-slate-400">
              {isRegister
                ? "يسجل الحساب بدون شركات. بعد دخول تقييم ستضاف شركاته تلقائياً."
                : "ادخل بحساب التطبيق المحفوظ لديك."}
            </p>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-2 rounded-lg bg-slate-800 p-1">
            <button
              type="button"
              onClick={() => {
                setMode("login");
                resetError();
              }}
              className={`inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-semibold ${
                !isRegister
                  ? "bg-cyan-600 text-white"
                  : "text-slate-300 hover:bg-slate-700"
              }`}
            >
              <LogIn className="h-4 w-4" />
              دخول
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("register");
                resetError();
              }}
              className={`inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-semibold ${
                isRegister
                  ? "bg-cyan-600 text-white"
                  : "text-slate-300 hover:bg-slate-700"
              }`}
            >
              <UserPlus className="h-4 w-4" />
              تسجيل
            </button>
          </div>

          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <label className="text-xs font-medium text-slate-300">
              رقم الهاتف
              <div className="mt-1 flex items-center rounded-lg border border-slate-600 bg-slate-800 px-3 focus-within:border-cyan-500">
                <Phone className="h-4 w-4 text-slate-500" />
                <input
                  type="text"
                  autoComplete="tel"
                  value={phone}
                  onChange={(ev) => setPhone(ev.target.value)}
                  className="w-full bg-transparent px-2 py-2 text-sm text-white outline-none"
                />
              </div>
            </label>
            <label className="text-xs font-medium text-slate-300">
              كلمة المرور
              <input
                type="password"
                autoComplete={
                  isRegister ? "new-password" : "current-password"
                }
                value={password}
                onChange={(ev) => setPassword(ev.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500"
              />
            </label>
            {isRegister ? (
              <label className="text-xs font-medium text-slate-300">
                تأكيد كلمة المرور
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(ev) => setConfirmPassword(ev.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500"
                />
              </label>
            ) : null}
            {error ? (
              <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-center text-xs text-rose-300">
                {error}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={submitting}
              className="mt-2 inline-flex items-center justify-center gap-2 rounded-lg bg-cyan-600 py-2.5 text-sm font-semibold text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? (
                "جاري التنفيذ..."
              ) : isRegister ? (
                <>
                  <UserPlus className="h-4 w-4" />
                  إنشاء الحساب
                </>
              ) : (
                <>
                  <LogIn className="h-4 w-4" />
                  دخول
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return children;
}

export default LocalAppLoginGate;
