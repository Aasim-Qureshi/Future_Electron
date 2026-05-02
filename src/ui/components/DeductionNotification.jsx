import React, { useEffect, useMemo, useState } from "react";
import navigation from "../constants/navigation";

const { DEFAULT_HOME_VIEW } = navigation;

const defaultMessageBuilder = (detail = {}) => {
  const reportIds =
    Array.isArray(detail.reportIds) && detail.reportIds.length
      ? detail.reportIds.join(", ")
      : detail.reportId;
  const reportLabel =
    reportIds ||
    detail.batchId ||
    detail.recordId ||
    "Report / batch";
  const pageLabel = detail.pageName || detail.source || "Reports";
  const assetSuffix = detail.assetCount ? ` (${detail.assetCount} assets)` : "";
  const points = Number.isFinite(detail.deducted) ? detail.deducted : 0;
  return `Deducted ${points} point${points === 1 ? "" : "s"} for ${reportLabel} on ${pageLabel}${assetSuffix}.`;
};

const matchesSource = (value, sourceProp, matcher) => {
  if (typeof matcher === "function") {
    return matcher(value);
  }
  if (Array.isArray(sourceProp)) {
    return sourceProp.includes(value);
  }
  if (typeof sourceProp === "string") {
    return value === sourceProp;
  }
  return false;
};

const DeductionNotification = ({
  source,
  sourceMatcher,
  defaultPageName,
  defaultPageSource,
  onViewChange,
}) => {
  const [notification, setNotification] = useState(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const handler = (event) => {
      const detail = event?.detail;
      if (!detail) return;
      const matches = matchesSource(detail.source, source, sourceMatcher);
      if (!matches) return;
      setNotification({
        ...detail,
        pageName: detail.pageName || defaultPageName || detail.source || "Reports",
        pageSource:
          detail.pageSource || defaultPageSource || detail.source || "submit-reports-quickly",
        message: detail.message || defaultMessageBuilder(detail),
      });
      setExpanded(false);
    };

    window.addEventListener("points-updated", handler);
    return () => window.removeEventListener("points-updated", handler);
  }, [source, sourceMatcher, defaultPageName, defaultPageSource]);

  const reportLabel = useMemo(() => {
    if (!notification) return null;
    if (notification.reportId) return `Report ID: ${notification.reportId}`;
    if (Array.isArray(notification.reportIds) && notification.reportIds.length) {
      return `Report IDs: ${notification.reportIds.join(", ")}`;
    }
    if (notification.batchId) return `Batch: ${notification.batchId}`;
    if (notification.recordId) return `Record: ${notification.recordId}`;
    return "Report / batch (not available)";
  }, [notification]);

  const handleViewHistory = () => {
    if (!notification) return;
    localStorage.setItem(
      "notification-target",
      JSON.stringify({
        type: "deduction-history",
        deductionId: notification.deductionId || null,
        page: 1,
      }),
    );
    if (onViewChange) {
      onViewChange(DEFAULT_HOME_VIEW);
    }
  };

  if (!notification) return null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm p-3 space-y-2">
      <div className="flex items-center justify-between text-[11px] text-slate-500">
        <span>{notification.pageName}</span>
        <span className="uppercase tracking-[0.25em] text-[9px] text-slate-400">
          {notification.pageSource || "submit-reports-quickly"}
        </span>
      </div>

      <div className="space-y-1">
        <p className="text-[12px] font-semibold text-slate-900">
          Deducted {Number(notification.deducted) || 0} point
          {Number(notification.deducted) === 1 ? "" : "s"}
        </p>
        <p className="text-[11px] text-slate-500">{reportLabel}</p>
        <p
          className={`text-[12px] text-slate-700 leading-relaxed transition-all ${
            expanded ? "" : "line-clamp-2"
          }`}
        >
          {notification.message}
        </p>
      </div>

      <div className="flex items-center justify-between text-[10px] text-slate-500">
        <button
          type="button"
          className="text-blue-700 hover:text-blue-900 font-semibold transition"
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
        <button
          type="button"
          className="rounded-full border border-blue-500/60 px-3 py-1 text-[10px] font-semibold text-blue-600 hover:bg-blue-50 transition"
          onClick={handleViewHistory}
        >
          History of Deduction
        </button>
      </div>
    </div>
  );
};

export default DeductionNotification;
