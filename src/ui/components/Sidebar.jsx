import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Building2,
  ChevronRight,
  FileSpreadsheet,
  Loader2,
  PanelLeftClose,
  PanelRightClose,
  Settings,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useValueNav } from "../context/ValueNavContext";

const getCompanySelectionKey = (company) => {
  if (!company) return "";
  return String(
    company.officeId ||
      company.office_id ||
      company.url ||
      company.id ||
      company.name ||
      "",
  );
};

/**
 * @param {object} props
 * @param {string} props.currentView
 * @param {(viewId: string) => void} props.onViewChange
 * @param {boolean} [props.showDesktopCollapse=true]
 * @param {() => void} [props.onRequestCollapse]
 * @param {boolean} [props.railMode=false]
 * @param {() => void} [props.onRequestExpand]
 */
const Sidebar = ({
  currentView,
  onViewChange,
  showDesktopCollapse = true,
  onRequestCollapse,
  railMode = false,
  onRequestExpand,
}) => {
  const { t, i18n } = useTranslation();
  const dir = i18n?.dir?.(i18n?.resolvedLanguage || i18n?.language) || "ltr";
  const isRtl = dir === "rtl";
  const {
    setActiveGroup,
    setActiveTab,
    companies,
    loadingCompanies,
    selectedCompany,
    setSelectedCompany,
  } = useValueNav();

  const [railCompanyOpen, setRailCompanyOpen] = useState(false);
  /** Fixed menu anchor (viewport px); menu rendered via portal on document.body */
  const [railMenuPos, setRailMenuPos] = useState(null);
  const railTriggerRef = useRef(null);
  const railMenuPanelRef = useRef(null);

  const computeRailMenuPosition = useCallback(() => {
    const el = railTriggerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const panelWidth = Math.min(window.innerWidth * 0.85, 288);
    const margin = 6;
    let left = isRtl ? rect.left - panelWidth - margin : rect.right + margin;
    if (!isRtl && left + panelWidth > window.innerWidth - 8) {
      left = Math.max(8, rect.left - panelWidth - margin);
    }
    if (isRtl && left < 8) {
      left = Math.min(window.innerWidth - panelWidth - 8, rect.right + margin);
    }
    left = Math.max(8, Math.min(left, window.innerWidth - panelWidth - 8));
    const top = Math.max(
      8,
      Math.min(rect.top, window.innerHeight - 120),
    );
    return { top, left };
  }, [isRtl]);

  useEffect(() => {
    if (!railMode) {
      setRailCompanyOpen(false);
      setRailMenuPos(null);
    }
  }, [railMode]);

  useLayoutEffect(() => {
    if (!railCompanyOpen || !railMode) return;
    const pos = computeRailMenuPosition();
    if (pos) setRailMenuPos(pos);
  }, [railCompanyOpen, railMode, computeRailMenuPosition, companies?.length]);

  useEffect(() => {
    if (!railCompanyOpen) return;
    const onReposition = () => {
      const pos = computeRailMenuPosition();
      if (pos) setRailMenuPos(pos);
    };
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [railCompanyOpen, computeRailMenuPosition]);

  useEffect(() => {
    if (!railCompanyOpen) return;
    let detach = () => {};
    const timer = window.setTimeout(() => {
      const close = (e) => {
        const t = railTriggerRef.current;
        const p = railMenuPanelRef.current;
        if (t?.contains(e.target) || p?.contains(e.target)) return;
        setRailCompanyOpen(false);
        setRailMenuPos(null);
      };
      document.addEventListener("mousedown", close);
      document.addEventListener("touchstart", close, { passive: true });
      detach = () => {
        document.removeEventListener("mousedown", close);
        document.removeEventListener("touchstart", close);
      };
    }, 0);
    return () => {
      window.clearTimeout(timer);
      detach();
    };
  }, [railCompanyOpen]);

  const go = (viewId) => {
    setActiveGroup("uploadReports");
    setActiveTab(viewId);
    onViewChange?.(viewId);
  };

  const iconNavActive = (id) => {
    const active = currentView === id;
    return [
      "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors",
      active
        ? "bg-white/16 text-white"
        : "bg-white/6 text-slate-200 hover:bg-white/11 hover:text-white",
    ].join(" ");
  };

  const navRowButtonClass = (id) => {
    const active = currentView === id;
    return [
      "flex w-full flex-row items-center gap-2 rounded-lg px-2.5 py-2 text-start text-[12px] font-semibold transition-colors",
      active
        ? "bg-white/12 text-white"
        : "text-slate-300 hover:bg-white/7 hover:text-white",
    ].join(" ");
  };

  const handleCompanySelectChange = async (event) => {
    const value = event.target.value;
    if (!value) {
      await setSelectedCompany(null, { skipNavigation: true });
      return;
    }
    const company = (companies || []).find(
      (c) => getCompanySelectionKey(c) === value,
    );
    if (company) {
      await setSelectedCompany(company, { skipNavigation: true });
    }
  };

  const pickRailCompany = async (company) => {
    if (!company) {
      await setSelectedCompany(null, { skipNavigation: true });
    } else {
      await setSelectedCompany(company, { skipNavigation: true });
    }
    setRailCompanyOpen(false);
    setRailMenuPos(null);
  };

  const selectedKey = getCompanySelectionKey(selectedCompany);
  const CollapseIcon = isRtl ? PanelRightClose : PanelLeftClose;
  const hasCompaniesList = !!companies && companies.length > 0;
  const companySelectDisabled = loadingCompanies || !hasCompaniesList;

  if (railMode) {
    return (
      <aside
        className={`flex h-full w-full min-w-0 flex-col border-[#3d7dae]/50 bg-[#124665] ${
          isRtl ? "border-s" : "border-e"
        }`}
      >
        <div className="flex flex-col items-center border-b border-white/5 px-1 py-2">
          {onRequestExpand ? (
            <button
              type="button"
              onClick={onRequestExpand}
              title={t("sidebar.expandSidebar")}
              aria-label={t("sidebar.expandSidebar")}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-600/30 text-white transition hover:bg-emerald-600/45"
            >
              <ChevronRight
                className={`h-5 w-5 ${isRtl ? "rotate-180" : ""}`}
                aria-hidden
              />
            </button>
          ) : null}
        </div>

        <nav className="flex flex-1 flex-col items-center gap-2 overflow-y-auto px-1 py-2">
          {loadingCompanies ? (
            <Loader2 className="h-5 w-5 shrink-0 animate-spin text-emerald-300" />
          ) : null}

          {!loadingCompanies && (!companies || companies.length === 0) ? (
            <div className="px-1 text-center">
              <Building2
                className="mx-auto h-6 w-6 text-amber-400/70"
                aria-hidden
              />
            </div>
          ) : null}

          {!loadingCompanies && hasCompaniesList ? (
            <div className="relative flex w-full justify-center">
              <button
                ref={railTriggerRef}
                type="button"
                disabled={companySelectDisabled}
                onClick={() => {
                  if (companySelectDisabled) return;
                  setRailCompanyOpen((open) => {
                    if (open) {
                      setRailMenuPos(null);
                      return false;
                    }
                    return true;
                  });
                }}
                aria-expanded={railCompanyOpen}
                aria-haspopup="listbox"
                title={t("sidebar.companySelectPlaceholder")}
                className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-white/8 text-slate-100 transition hover:bg-white/14 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Building2 className="h-4 w-4" aria-hidden />
              </button>
              {railCompanyOpen &&
              !companySelectDisabled &&
              railMenuPos &&
              typeof document !== "undefined"
                ? createPortal(
                    <div
                      ref={railMenuPanelRef}
                      className="fixed z-[10050] min-w-[13.5rem] max-w-[min(85vw,18rem)] overflow-hidden rounded-xl bg-[#1a5280] py-1 shadow-xl ring-1 ring-black/20"
                      style={{
                        top: railMenuPos.top,
                        left: railMenuPos.left,
                      }}
                    >
                      <ul role="listbox" className="max-h-[min(70vh,22rem)] overflow-y-auto py-0">
                        <li role="none">
                          <button
                            type="button"
                            role="option"
                            aria-selected={!selectedKey}
                            onClick={() => pickRailCompany(null)}
                            className={`w-full px-3 py-2 text-start text-[11px] font-medium transition ${
                              !selectedKey
                                ? "bg-emerald-600/25 text-emerald-50"
                                : "text-slate-200 hover:bg-white/8"
                            }`}
                          >
                            {t("sidebar.companySelectPlaceholder")}
                          </button>
                        </li>
                        {companies.map((company) => {
                          const key = getCompanySelectionKey(company);
                          const active = key === selectedKey;
                          return (
                            <li key={key} role="none">
                              <button
                                type="button"
                                role="option"
                                aria-selected={active}
                                onClick={() => pickRailCompany(company)}
                                className={`w-full px-3 py-2 text-start text-[11px] font-medium transition ${
                                  active
                                    ? "bg-emerald-600/25 text-emerald-50"
                                    : "text-slate-200 hover:bg-white/8"
                                }`}
                              >
                                {company.name || t("sidebar.company.fallback")}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>,
                    document.body,
                  )
                : null}
            </div>
          ) : null}

          {selectedCompany ? (
            <>
              <button
                type="button"
                title={t("navigation.tabs.upload-report-elrajhi.label", {
                  defaultValue: "رفع تقارير (الراجحي)",
                })}
                aria-label={t("navigation.tabs.upload-report-elrajhi.label", {
                  defaultValue: "رفع تقارير (الراجحي)",
                })}
                className={iconNavActive("upload-report-elrajhi")}
                onClick={() => go("upload-report-elrajhi")}
              >
                <FileSpreadsheet className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                title={t("navigation.tabs.submit-reports-quickly.label", {
                  defaultValue: "رفع سريع",
                })}
                aria-label={t("navigation.tabs.submit-reports-quickly.label", {
                  defaultValue: "رفع سريع",
                })}
                className={iconNavActive("submit-reports-quickly")}
                onClick={() => go("submit-reports-quickly")}
              >
                <Zap className="h-4 w-4" aria-hidden />
              </button>
            </>
          ) : null}

          <div className="min-h-[4px] flex-1" />
        </nav>

        <div className="border-t border-white/5 px-1 py-2">
          <div className="flex justify-center">
            <button
              type="button"
              title={t("sidebar.openSettings")}
              aria-label={t("sidebar.openSettings")}
              onClick={() => onViewChange?.("system-settings")}
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-white/8 text-slate-100 transition hover:bg-white/14"
            >
              <Settings className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside
      className={`flex h-full w-full min-w-0 flex-col border-[#3d7dae]/50 bg-[#124665] shadow-[2px_0_12px_rgba(0,0,0,0.1)] ${
        isRtl ? "border-s" : "border-e"
      }`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-white/5 bg-[#0d3350]/92 px-3 py-2.5">
        <div className="min-w-0 flex-1 text-[12px] font-bold leading-tight tracking-tight text-white">
          {t("navigation.uploadRoot", { defaultValue: "رفع التقارير" })}
        </div>
        {showDesktopCollapse && onRequestCollapse ? (
          <button
            type="button"
            onClick={onRequestCollapse}
            title={t("sidebar.collapseSidebar")}
            aria-label={t("sidebar.collapseSidebar")}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-200 transition hover:bg-white/10 hover:text-white"
          >
            <CollapseIcon className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>

      <nav className="flex flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden px-2.5 py-3">
        {loadingCompanies ? (
          <div className="flex items-center gap-2 rounded-lg bg-white/6 px-2.5 py-2 text-[11px] text-slate-300">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-emerald-300" />
            {t("sidebar.company.loading")}
          </div>
        ) : null}

        {!loadingCompanies && (!companies || companies.length === 0) ? (
          <div className="rounded-lg bg-amber-950/30 px-2.5 py-2 text-[11px] leading-snug text-amber-50">
            {t("sidebar.company.empty")}
          </div>
        ) : null}

        {!loadingCompanies && hasCompaniesList ? (
          <div className="rounded-lg bg-white/[0.05] p-2.5">
            <div className="flex flex-row items-center gap-2">
              <Building2
                className="h-4 w-4 shrink-0 text-emerald-300/90"
                aria-hidden
              />
              <div className="relative min-w-0 flex-1">
                <select
                  id="sidebar-company-select"
                  aria-label={t("sidebar.companySelectPlaceholder")}
                  value={selectedKey}
                  onChange={handleCompanySelectChange}
                  className="w-full appearance-none rounded-lg bg-[#0b3554] py-2 ps-2 pe-8 text-[11px] font-semibold text-white outline-none transition focus-visible:ring-2 focus-visible:ring-emerald-400/35"
                >
                  <option value="">
                    {t("sidebar.companySelectPlaceholder")}
                  </option>
                  {companies.map((company) => {
                    const key = getCompanySelectionKey(company);
                    return (
                      <option key={key} value={key}>
                        {company.name || t("sidebar.company.fallback")}
                      </option>
                    );
                  })}
                </select>
                <span className="pointer-events-none absolute inset-y-0 flex items-center pe-2 text-slate-400 end-0">
                  <span className="text-[9px]">▾</span>
                </span>
              </div>
            </div>
            {!selectedCompany ? (
              <p className="mt-2 text-[10px] leading-relaxed text-slate-400 ps-6">
                {t("sidebar.selectCompanyHintShort")}
              </p>
            ) : null}
          </div>
        ) : null}

        {selectedCompany ? (
          <div className="flex flex-col gap-1 rounded-lg bg-[#0b3554]/75 p-1.5">
            <button
              type="button"
              className={navRowButtonClass("upload-report-elrajhi")}
              onClick={() => go("upload-report-elrajhi")}
            >
              <FileSpreadsheet className="h-4 w-4 shrink-0 opacity-95" aria-hidden />
              <span className="min-w-0 truncate">
                {t("navigation.tabs.upload-report-elrajhi.label", {
                  defaultValue: "رفع تقارير (الراجحي)",
                })}
              </span>
            </button>
            <button
              type="button"
              className={navRowButtonClass("submit-reports-quickly")}
              onClick={() => go("submit-reports-quickly")}
            >
              <Zap className="h-4 w-4 shrink-0 opacity-95" aria-hidden />
              <span className="min-w-0 truncate">
                {t("navigation.tabs.submit-reports-quickly.label", {
                  defaultValue: "رفع سريع",
                })}
              </span>
            </button>
          </div>
        ) : null}
      </nav>

      <div className="border-t border-white/5 bg-[#0c3350]/90 p-2.5">
        <button
          type="button"
          onClick={() => onViewChange?.("system-settings")}
          className="flex w-full flex-row items-center justify-center gap-2 rounded-lg bg-white/8 px-2.5 py-2 text-[11px] font-semibold text-slate-100 transition hover:bg-white/12"
        >
          <Settings className="h-3.5 w-3.5 text-slate-300 shrink-0" aria-hidden />
          {t("sidebar.openSettings")}
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
