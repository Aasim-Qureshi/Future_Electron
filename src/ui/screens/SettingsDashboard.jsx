import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowLeft,
  BarChart3,
  Building2,
  Loader2,
  LogOut,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSession } from "../context/SessionContext";
import { useSystemControl } from "../context/SystemControlContext";
import { useRam, calculateRecommendedTabs } from "../context/RAMContext";
import { useValueNav } from "../context/ValueNavContext";
import { loadUploadStats, clearUploadStats, subscribeUploadStats } from "../utils/reportUploadStats";
import { fetchUploadStatsFromApi } from "../../api/uploadStats";
import { patchWorkspacePreferences } from "../../api/workspacePreferences";
import navigation from "../constants/navigation";

const { DEFAULT_HOME_VIEW } = navigation;

const formatTs = (ts, locale) => {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString(locale);
  } catch {
    return "—";
  }
};

const officeIdOf = (company) =>
  String(company?.officeId || company?.office_id || "").trim();

const SettingsDashboard = ({ onViewChange }) => {
  const { t, i18n } = useTranslation();
  const locale = i18n?.language || "en";
  const dir = i18n?.dir?.(i18n?.resolvedLanguage || i18n?.language) || "ltr";
  const isRtl = dir === "rtl";
  const { user, logout, isGuest, token, updateUser } = useSession();
  const {
    systemState,
    latestUpdate,
    userUpdateState,
    loadingState,
    loadingUpdate,
    fetchSystemState,
    fetchUpdateNotice,
    updateBlocked,
  } = useSystemControl();
  const { ramInfo, readingRam, readRam, isAvailable: ramAvailable, tabsPerGb } = useRam();
  const [ramDraft, setRamDraft] = useState(String(tabsPerGb));
  const [ramSaving, setRamSaving] = useState(false);
  const [ramMsg, setRamMsg] = useState("");

  const draftTabsPerGb = useMemo(() => {
    const n = Number(ramDraft);
    return Number.isFinite(n) && n >= 1 && n <= 20 ? n : 5;
  }, [ramDraft]);

  const previewRecommendedTabs = useMemo(() => {
    if (ramInfo?.freeGb == null || !Number.isFinite(Number(ramInfo.freeGb))) return null;
    return calculateRecommendedTabs(ramInfo.freeGb, draftTabsPerGb);
  }, [ramInfo?.freeGb, draftTabsPerGb]);
  const {
    companies,
    loadingCompanies,
    setPreferredCompany,
    defaultCompanyOfficeId,
    preferredCompanyKey,
    refreshCompaniesFromTaqeem,
    companyError,
  } = useValueNav();

  const [statsVersion, setStatsVersion] = useState(0);
  const [remoteItems, setRemoteItems] = useState(undefined);
  const [statsLoading, setStatsLoading] = useState(false);

  const [companyOfficeDraft, setCompanyOfficeDraft] = useState("");
  const [companySaving, setCompanySaving] = useState(false);
  const [companyMsg, setCompanyMsg] = useState("");

  useEffect(() => subscribeUploadStats(() => setStatsVersion((v) => v + 1)), []);

  useEffect(() => {
    setRamDraft(String(tabsPerGb));
  }, [tabsPerGb]);

  const resolvedDefaultOffice = useMemo(() => {
    const fromServer = String(defaultCompanyOfficeId || "").trim();
    if (fromServer) return fromServer;
    const fromPreferred = String(preferredCompanyKey || "").trim();
    if (!fromPreferred || !companies?.length) return fromPreferred;
    const match = companies.find((c) => officeIdOf(c) === fromPreferred);
    if (match) return fromPreferred;
    return "";
  }, [defaultCompanyOfficeId, preferredCompanyKey, companies]);

  useEffect(() => {
    setCompanyOfficeDraft(resolvedDefaultOffice);
  }, [resolvedDefaultOffice]);

  useEffect(() => {
    if (isGuest || !token) {
      setRemoteItems(undefined);
      setStatsLoading(false);
      return undefined;
    }
    let cancelled = false;
    setStatsLoading(true);
    fetchUploadStatsFromApi()
      .then(({ data }) => {
        if (!cancelled) {
          setRemoteItems(data?.items || []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRemoteItems(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setStatsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, isGuest, statsVersion]);

  const statsRows = useMemo(() => {
    const buildFromServer = (items) =>
      (items || [])
        .map((item) => {
          const officeKey = item.officeId;
          const fromList = (companies || []).find(
            (c) => String(c.officeId || c.office_id || "") === officeKey,
          );
          const name =
            officeKey === "_unknown"
              ? item.companyNameHint || t("settingsDashboard.uploadStats.unknownCompany")
              : fromList?.name || item.companyNameHint || officeKey;
          return {
            key: officeKey,
            name,
            quick: {
              submitted: item.quick?.submitted || 0,
              failed: item.quick?.failed || 0,
              batches: item.quick?.batches || 0,
              lastAt: item.quick?.lastAt ?? null,
            },
            elrajhi: {
              submitted: item.elrajhi?.submitted || 0,
              failed: item.elrajhi?.failed || 0,
              batches: item.elrajhi?.batches || 0,
              lastAt: item.elrajhi?.lastAt ?? null,
            },
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, locale));

    const buildFromLocal = () => {
      void statsVersion;
      const raw = loadUploadStats();
      return Object.entries(raw)
        .map(([officeKey, row]) => {
          const fromList = (companies || []).find(
            (c) => String(c.officeId || c.office_id || "") === officeKey,
          );
          const name =
            officeKey === "_unknown"
              ? row.nameHint || t("settingsDashboard.uploadStats.unknownCompany")
              : fromList?.name || row.nameHint || officeKey;
          return {
            key: officeKey,
            name,
            quick: row.quick || { submitted: 0, failed: 0, batches: 0, lastAt: null },
            elrajhi: row.elrajhi || { submitted: 0, failed: 0, batches: 0, lastAt: null },
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, locale));
    };

    if (token && !isGuest) {
      if (statsLoading || remoteItems === undefined) {
        return [];
      }
      if (Array.isArray(remoteItems)) {
        return buildFromServer(remoteItems);
      }
      return buildFromLocal();
    }
    return buildFromLocal();
  }, [companies, statsVersion, locale, t, token, isGuest, remoteItems, statsLoading]);

  const mode = systemState?.mode || "active";

  const flash = useCallback((setter, key) => {
    setter(t(key));
    window.setTimeout(() => setter(""), 2800);
  }, [t]);

  const handleSaveRam = async () => {
    const n = Number(ramDraft);
    const value = Number.isFinite(n) && n >= 1 && n <= 20 ? Math.round(n) : 5;
    if (!token) {
      flash(setRamMsg, "settingsDashboard.workspace.tabsSaveFailed");
      return;
    }
    setRamSaving(true);
    setRamMsg("");
    try {
      const { data } = await patchWorkspacePreferences({ ramTabsPerGb: value });
      if (data?.user) updateUser(data.user);
      flash(setRamMsg, "settingsDashboard.workspace.tabsSaved");
    } catch {
      flash(setRamMsg, "settingsDashboard.workspace.tabsSaveFailed");
    } finally {
      setRamSaving(false);
    }
  };

  const handleResetRam = async () => {
    if (!token) {
      flash(setRamMsg, "settingsDashboard.workspace.tabsSaveFailed");
      return;
    }
    setRamSaving(true);
    setRamMsg("");
    try {
      const { data } = await patchWorkspacePreferences({ ramTabsPerGb: null });
      if (data?.user) updateUser(data.user);
      flash(setRamMsg, "settingsDashboard.workspace.tabsReset");
    } catch {
      flash(setRamMsg, "settingsDashboard.workspace.tabsSaveFailed");
    } finally {
      setRamSaving(false);
    }
  };

  const handleSaveDefaultCompany = async () => {
    const id = String(companyOfficeDraft || "").trim();
    if (!id) {
      flash(setCompanyMsg, "settingsDashboard.workspace.pickCompany");
      return;
    }
    const company = companies.find((c) => officeIdOf(c) === id);
    if (!company) {
      flash(setCompanyMsg, "settingsDashboard.workspace.pickCompany");
      return;
    }
    setCompanySaving(true);
    setCompanyMsg("");
    try {
      await setPreferredCompany(company, {
        applySelection: true,
        skipNavigation: true,
        persistDefault: true,
      });
      flash(setCompanyMsg, "settingsDashboard.workspace.companySaved");
    } catch {
      flash(setCompanyMsg, "settingsDashboard.workspace.companySaveFailed");
    } finally {
      setCompanySaving(false);
    }
  };

  const handleLogout = () => {
    logout();
    onViewChange?.(DEFAULT_HOME_VIEW);
  };

  const pillBtn =
    "inline-flex items-center justify-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs font-medium text-stone-800 shadow-sm transition hover:border-stone-300 hover:bg-stone-50 disabled:opacity-45";
  const primaryBtn =
    "inline-flex items-center justify-center gap-2 rounded-lg bg-stone-900 px-4 py-2 text-xs font-medium text-white transition hover:bg-stone-800 disabled:opacity-45";

  return (
    <div className="min-h-full bg-[#f3f2ef]" dir={dir}>
      <div className="mx-auto max-w-2xl px-4 pb-16 pt-8 sm:px-6 sm:pt-10">
        <div className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-[1.35rem] font-semibold tracking-tight text-stone-900 sm:text-2xl">
            {t("settingsDashboard.title")}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => onViewChange?.(DEFAULT_HOME_VIEW)} className={pillBtn}>
              <ArrowLeft className={`h-4 w-4 text-stone-500 ${isRtl ? "rotate-180" : ""}`} />
              {t("settingsDashboard.backToUploads")}
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className={`${pillBtn} border-rose-100 text-rose-800 hover:bg-rose-50`}
            >
              <LogOut className="h-4 w-4" />
              {t("layout.auth.logout")}
            </button>
          </div>
        </div>

        <div className="space-y-6 rounded-2xl border border-stone-200/90 bg-white p-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)] sm:p-8">
          <div className="grid gap-8 sm:gap-10 md:grid-cols-2 md:divide-x md:divide-stone-100 rtl:md:divide-x-reverse">
            <div className="md:pe-8 rtl:md:pe-0 rtl:md:ps-8">
              <h2 className="text-sm font-medium text-stone-900">
                {t("settingsDashboard.workspace.tabsTitle")}
              </h2>
              <div className="mt-5 space-y-4">
                <input
                  type="range"
                  min={1}
                  max={20}
                  value={Math.min(20, Math.max(1, Number(ramDraft) || 5))}
                  onChange={(e) => setRamDraft(e.target.value)}
                  disabled={!token || ramSaving}
                  className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-stone-200 accent-stone-800 disabled:opacity-45"
                />
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={ramDraft}
                    onChange={(e) => setRamDraft(e.target.value)}
                    disabled={!token || ramSaving}
                    className="w-16 rounded-md border border-stone-200 bg-stone-50/80 py-2 text-center text-sm font-medium text-stone-900 tabular-nums disabled:opacity-45"
                  />
                  <span className="text-xs text-stone-400">{t("settingsDashboard.workspace.perGbUnit")}</span>
                </div>
                <div className="rounded-md border border-stone-100 bg-stone-50/80 px-3 py-2.5">
                  {previewRecommendedTabs != null ? (
                    <p className="text-xs text-stone-700">
                      <span className="font-medium text-stone-900">{t("layout.ram.recommendedTabs")}</span>
                      <span className="mx-1.5 tabular-nums font-semibold text-stone-900">
                        {previewRecommendedTabs}
                      </span>
                    </p>
                  ) : ramAvailable ? (
                    <p className="text-xs text-stone-500">{t("settingsDashboard.workspace.recommendedPreviewPending")}</p>
                  ) : (
                    <p className="text-xs text-stone-500">{t("layout.ram.unavailable")}</p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <button type="button" onClick={handleSaveRam} disabled={!token || ramSaving} className={primaryBtn}>
                    {ramSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {t("settingsDashboard.workspace.saveTabs")}
                  </button>
                  <button
                    type="button"
                    onClick={handleResetRam}
                    disabled={!token || ramSaving}
                    className={`${pillBtn} py-2`}
                  >
                    <RotateCcw className="h-3.5 w-3.5 text-stone-500" />
                    {t("settingsDashboard.workspace.resetTabs")}
                  </button>
                </div>
                {ramMsg ? <p className="text-xs text-emerald-700">{ramMsg}</p> : null}
                {!token ? <p className="text-xs text-stone-400">{t("settingsDashboard.workspace.needAccount")}</p> : null}
              </div>
            </div>

            <div className="md:ps-8 rtl:md:ps-0 rtl:md:pe-8">
              <h2 className="text-sm font-medium text-stone-900">
                {t("settingsDashboard.workspace.companyTitle")}
              </h2>
              <div className="mt-5 space-y-4">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void refreshCompaniesFromTaqeem()}
                    disabled={loadingCompanies}
                    className={`${pillBtn} shrink-0 px-2.5 py-2`}
                    title={t("settingsDashboard.workspace.refreshCompanies")}
                  >
                    {loadingCompanies ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4 text-stone-500" />
                    )}
                  </button>
                  <select
                    value={companyOfficeDraft}
                    onChange={(e) => setCompanyOfficeDraft(e.target.value)}
                    disabled={!companies.length || companySaving}
                    className="min-w-0 flex-1 rounded-md border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 outline-none ring-stone-900/10 focus:ring-2 disabled:opacity-45"
                  >
                    <option value="">{t("settingsDashboard.workspace.companyPlaceholder")}</option>
                    {companies.map((c) => {
                      const oid = officeIdOf(c);
                      return (
                        <option key={oid || c.url || c.name} value={oid}>
                          {c.name || t("sidebar.company.fallback")}
                        </option>
                      );
                    })}
                  </select>
                </div>
                {companyError ? <p className="text-xs text-rose-600">{companyError}</p> : null}
                <button
                  type="button"
                  onClick={() => void handleSaveDefaultCompany()}
                  disabled={!companies.length || companySaving || !companyOfficeDraft}
                  className={primaryBtn}
                >
                  {companySaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Building2 className="h-4 w-4" />}
                  {t("settingsDashboard.workspace.saveCompany")}
                </button>
                {companyMsg ? <p className="text-xs text-emerald-700">{companyMsg}</p> : null}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-xl border border-stone-200/90 bg-white px-4 py-4 shadow-sm">
            <div className="text-xs font-medium text-stone-500">{t("settingsDashboard.cards.system")}</div>
            <div className="mt-2 text-sm font-medium text-stone-900">{mode}</div>
            {updateBlocked() ? (
              <p className="mt-2 text-[11px] text-amber-800">{t("layout.messages.updateBlocked")}</p>
            ) : null}
            <button
              type="button"
              onClick={() => fetchSystemState()}
              disabled={loadingState}
              className={`mt-3 w-full ${pillBtn} py-2`}
            >
              {loadingState ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4 text-stone-500" />}
              {t("layout.status.refresh")}
            </button>
          </div>
          <div className="rounded-xl border border-stone-200/90 bg-white px-4 py-4 shadow-sm">
            <div className="text-xs font-medium text-stone-500">{t("layout.nav.deviceCapability")}</div>
            <div className="mt-2 text-sm text-stone-800">
              {!ramAvailable ? (
                <span className="text-stone-400">{t("layout.ram.unavailable")}</span>
              ) : ramInfo ? (
                <span className="tabular-nums">
                  {ramInfo.usedGb}/{ramInfo.totalGb} GB
                </span>
              ) : (
                <span className="text-stone-400">—</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => readRam()}
              disabled={!ramAvailable || readingRam}
              className={`mt-3 w-full ${pillBtn} py-2`}
            >
              {readingRam ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4 text-stone-500" />}
              {t("layout.ram.refreshTitle")}
            </button>
          </div>
          <div className="rounded-xl border border-stone-200/90 bg-white px-4 py-4 shadow-sm">
            <div className="text-xs font-medium text-stone-500">{t("settingsDashboard.cards.updates")}</div>
            <div className="mt-2 text-sm font-medium text-stone-900">
              {latestUpdate ? `v${latestUpdate.version}` : "—"}
            </div>
            {latestUpdate?.description ? (
              <p className="mt-1 line-clamp-2 text-xs text-stone-500">{latestUpdate.description}</p>
            ) : null}
            <div className="mt-1 text-[11px] text-stone-400">
              {userUpdateState?.status ? String(userUpdateState.status) : ""}
            </div>
            <button
              type="button"
              onClick={() => fetchUpdateNotice()}
              disabled={loadingUpdate || !token}
              className={`mt-3 w-full ${pillBtn} py-2`}
            >
              {loadingUpdate ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4 text-stone-500" />}
              {t("settingsDashboard.refreshUpdates")}
            </button>
          </div>
        </div>

        <div className="mt-6 overflow-hidden rounded-xl border border-stone-200/90 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-stone-100 px-4 py-3 sm:px-5">
            <div className="flex items-center gap-2 text-stone-900">
              <BarChart3 className="h-4 w-4 text-stone-500" />
              <h2 className="text-sm font-medium">{t("settingsDashboard.uploadStats.title")}</h2>
            </div>
            {statsRows.length > 0 ? (
              <button
                type="button"
                onClick={async () => {
                  await clearUploadStats();
                  setStatsVersion((v) => v + 1);
                }}
                className="text-xs font-medium text-rose-600 hover:text-rose-700"
              >
                {t("settingsDashboard.uploadStats.clear")}
              </button>
            ) : null}
          </div>
          <div className="p-4 sm:p-5">
            {statsLoading && token && !isGuest ? (
              <div className="flex items-center gap-2 text-xs text-stone-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{t("settingsDashboard.uploadStats.loading")}</span>
              </div>
            ) : statsRows.length === 0 ? (
              <p className="text-xs text-stone-400">{t("settingsDashboard.uploadStats.empty")}</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-stone-100">
                <table className="min-w-full text-left text-xs text-stone-700">
                  <thead className="bg-stone-50/90 text-[10px] font-medium uppercase tracking-wide text-stone-500">
                    <tr>
                      <th className="px-3 py-2.5">{t("settingsDashboard.uploadStats.company")}</th>
                      <th className="px-3 py-2.5">{t("settingsDashboard.uploadStats.quick")}</th>
                      <th className="px-3 py-2.5">{t("settingsDashboard.uploadStats.elRajhi")}</th>
                      <th className="px-3 py-2.5">{t("settingsDashboard.uploadStats.lastActivity")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statsRows.map((row) => {
                      const lastQuick = row.quick.lastAt;
                      const lastEl = row.elrajhi.lastAt;
                      const last = Math.max(lastQuick || 0, lastEl || 0) || null;
                      return (
                        <tr key={row.key} className="border-t border-stone-100 bg-white">
                          <td className="px-3 py-2.5 font-medium text-stone-900">{row.name}</td>
                          <td className="px-3 py-2.5 tabular-nums">
                            <span className="text-stone-900">{row.quick.submitted}</span>
                            {row.quick.failed > 0 ? (
                              <span className="ms-1 text-rose-600">−{row.quick.failed}</span>
                            ) : null}
                          </td>
                          <td className="px-3 py-2.5 tabular-nums">
                            <span className="text-stone-900">{row.elrajhi.submitted}</span>
                            {row.elrajhi.failed > 0 ? (
                              <span className="ms-1 text-rose-600">−{row.elrajhi.failed}</span>
                            ) : null}
                          </td>
                          <td className="px-3 py-2.5 text-stone-500">{formatTs(last, locale)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <p className="mt-10 text-center text-[11px] text-stone-400">
          {isGuest ? t("layout.auth.guest") : user?.phone || user?.id || "—"}
        </p>
      </div>
    </div>
  );
};

export default SettingsDashboard;
