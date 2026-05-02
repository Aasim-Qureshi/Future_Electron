/**
 * لا يوجد خصم نقاط أو باقات — يُحتفظ بالدالة للتوافق مع شاشات التقارير.
 */
export const deductPoints = async (token, amount, meta = {}) => {
  const normalized = Number(amount);
  if (!token || !Number.isFinite(normalized) || normalized <= 0) return null;

  const detail = {
    remainingPoints: Number.MAX_SAFE_INTEGER,
    deducted: normalized,
    ...meta,
    message: meta.message || "points-deduct-disabled",
    createdAt: new Date().toISOString(),
  };

  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function"
  ) {
    window.dispatchEvent(new CustomEvent("points-updated", { detail }));
  }

  return {
    remainingPoints: detail.remainingPoints,
    deducted: normalized,
    ...meta,
    createdAt: detail.createdAt,
  };
};
