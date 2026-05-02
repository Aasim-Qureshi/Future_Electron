import React, { useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './Sidebar';
import {
    AlertTriangle,
    AppWindow,
    Bell,
    Building2,
    ChevronDown,
    CircleDot,
    Compass,
    Download,
    FileText,
    HardDrive,
    Layers,
    Loader2,
    LogOut,
    Menu,
    RefreshCcw,
    Settings,
    ShieldCheck,
    Trash2,
    UploadCloud
} from 'lucide-react';
import { getHealth } from '../../api/health';
import buildVersion from '../../../build-version.json';
import { useSession, LOCAL_APP_USER_PHONE } from '../context/SessionContext';
import { useSystemControl } from '../context/SystemControlContext';
import { useNavStatus } from '../context/NavStatusContext';
import { useValueNav } from '../context/ValueNavContext';
import { useRam } from '../context/RAMContext'; // Updated import
import navigation from '../constants/navigation';
import { useTranslation } from 'react-i18next';
import usePersistentState from '../hooks/usePersistentState';
import { TAQEEM_CONFLICT_EVENT } from '../../shared/helper/taqeemSync';
import { canAccessGroup, filterTabsByAccess } from '../utils/viewAccess';
const { viewTitles, valueSystemGroups, findTabInfo, valueSystemCards, isValueSystemView, DEFAULT_HOME_VIEW } = navigation;
const API_BASE_URL = (
    (typeof process !== 'undefined' && process?.env?.REACT_APP_BACKEND_URL) ||
    (typeof process !== 'undefined' && process?.env?.BACKEND_URL) ||
    'http://localhost:3000'
);

const findCardForGroup = (groupId) =>
    valueSystemCards.find((card) => Array.isArray(card.groups) && card.groups.includes(groupId));

const heroThemes = {
    uploadReports: {
        surface: 'from-white via-neutral-50 to-neutral-100',
        accent: 'from-neutral-700 to-neutral-900',
        border: 'border-neutral-200/90',
        blob: 'bg-neutral-200/70',
        text: 'text-neutral-600'
    },
    uploadSingleReport: {
        surface: 'from-white via-emerald-50 to-teal-50',
        accent: 'from-emerald-500 to-teal-600',
        border: 'border-emerald-200/70',
        blob: 'bg-emerald-200/60',
        text: 'text-emerald-700'
    },
    taqeemInfo: {
        surface: 'from-white via-sky-50 to-indigo-50',
        accent: 'from-sky-500 to-indigo-600',
        border: 'border-sky-200/70',
        blob: 'bg-sky-200/60',
        text: 'text-sky-700'
    },
    deleteReport: {
        surface: 'from-white via-rose-50 to-orange-50',
        accent: 'from-rose-500 to-orange-500',
        border: 'border-rose-200/70',
        blob: 'bg-rose-200/60',
        text: 'text-rose-700'
    },
    myReports: {
        surface: 'from-white via-rose-50 to-orange-50',
        accent: 'from-rose-500 to-orange-500',
        border: 'border-rose-200/70',
        blob: 'bg-rose-200/60',
        text: 'text-rose-700'
    },
    evaluationSources: {
        surface: 'from-white via-amber-50 to-orange-50',
        accent: 'from-amber-500 to-orange-500',
        border: 'border-amber-200/70',
        blob: 'bg-amber-200/60',
        text: 'text-amber-700'
    },
    companyConsole: {
        surface: 'from-white via-emerald-50 to-teal-50',
        accent: 'from-emerald-500 to-teal-600',
        border: 'border-emerald-200/70',
        blob: 'bg-emerald-200/60',
        text: 'text-emerald-700'
    },
    settings: {
        surface: 'from-white via-slate-50 to-slate-100',
        accent: 'from-slate-600 to-slate-800',
        border: 'border-slate-200/80',
        blob: 'bg-slate-200/70',
        text: 'text-slate-600'
    },
    adminConsole: {
        surface: 'from-white via-amber-50 to-orange-50',
        accent: 'from-amber-500 to-orange-600',
        border: 'border-amber-200/70',
        blob: 'bg-amber-200/60',
        text: 'text-amber-700'
    },
    default: {
        surface: 'from-white via-slate-50 to-slate-100',
        accent: 'from-slate-700 to-slate-900',
        border: 'border-slate-200/80',
        blob: 'bg-slate-200/70',
        text: 'text-slate-600'
    }
};

const heroIcons = {
    uploadReports: UploadCloud,
    uploadSingleReport: FileText,
    taqeemInfo: Compass,
    deleteReport: Trash2,
    evaluationSources: Layers,
    settings: Settings,
    companyConsole: Building2,
    adminConsole: ShieldCheck
};

const getInitials = (label = '') => {
    const words = String(label).split(' ').filter(Boolean);
    const initials = words.slice(0, 3).map((word) => word[0]?.toUpperCase());
    return initials.join('') || 'VT';
};

const getCompanySelectionKey = (company) => {
    if (!company) return '';
    return String(
        company.officeId ||
        company.office_id ||
        company.url ||
        company.id ||
        company.name ||
        ''
    );
};

const POST_FETCH_COMPANY_MODAL_DISMISSED = 'vt:post-fetch-company-modal-dismissed';
const TAQEEM_HOME_URL = 'https://qima.taqeem.gov.sa/valuer/home';

const HeroArt = ({ label, theme, Icon }) => {
    const initials = getInitials(label);
    const SafeIcon = Icon || AppWindow;
    return (
        <div
            aria-hidden="true"
            className={`relative h-24 w-full max-w-[240px] overflow-hidden rounded-2xl border ${theme.border} bg-gradient-to-br ${theme.surface} shadow-sm`}
        >
            <div className={`pointer-events-none absolute -left-6 -top-6 h-20 w-20 rounded-full ${theme.blob}`} />
            <div className={`pointer-events-none absolute bottom-2 right-2 h-12 w-12 rounded-2xl bg-gradient-to-br ${theme.accent} opacity-90`} />
            <div className="relative flex h-full flex-col justify-between p-3">
                <span className={`inline-flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br ${theme.accent} text-white shadow-sm`}>
                    <SafeIcon className="h-4 w-4" />
                </span>
                <span className={`text-[10px] font-semibold uppercase tracking-[0.2em] ${theme.text}`}>{initials}</span>
            </div>
        </div>
    );
};

const Layout = ({ children, currentView, onViewChange }) => {
    const { isAuthenticated, user, logout, isGuest, token } = useSession();
    const { t, i18n } = useTranslation();
    const uiDir = i18n?.dir?.(i18n?.resolvedLanguage || i18n?.language) || 'ltr';
    const {
        systemState,
        latestUpdate,
        userUpdateState,
        loadingState,
        loadingUpdate,
        fetchSystemState,
        fetchUpdateNotice,
        markDownloaded,
        applyUpdate,
        isFeatureBlocked,
        blockReason,
        updateBlocked,
        updateSystemState
    } = useSystemControl();
    const { taqeemStatus, setCompanyStatus, setTaqeemStatus } = useNavStatus();
    const {
        breadcrumbs,
        activeGroup,
        activeTab,
        selectedDomain,
        selectedCompany,
        defaultCompanyOfficeId,
        companies,
        chooseCard,
        chooseDomain,
        setSelectedCompany,
        setPreferredCompany,
        preferredCompanyKey,
        setActiveGroup,
        setActiveTab,
        resetAll,
        resetNavigation,
        refreshCompaniesFromTaqeem,
        loadingCompanies
    } = useValueNav();

    // Use RAM context
    const {
        ramInfo,
        readingRam,
        error: ramError,
        readRam,
        startPolling,
        stopPolling,
        isAvailable: isRamAvailable
    } = useRam();

    const numberFormatter = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
    const formatNumber = (value) => {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numberFormatter.format(numeric) : value;
    };

    const isAdmin = user?.phone === '000';
    const blocked = isAuthenticated && (isFeatureBlocked(currentView) || updateBlocked());
    const blockMessage = blockReason(currentView);
    const mode = systemState?.mode || 'active';
    const modeLabel = t(`layout.modes.${mode}`, { defaultValue: mode });
    const [downtimeParts, setDowntimeParts] = useState(null);
    const [hideUpdateNotice, setHideUpdateNotice] = useState(false);
    const [postFetchCompanyModalOpen, setPostFetchCompanyModalOpen] = useState(false);
    const [backendVersion, setBackendVersion] = useState(null);
    const [companyModalSelection, setCompanyModalSelection] = useState(getCompanySelectionKey(selectedCompany));
    const [companyModalBusy, setCompanyModalBusy] = useState(false);
    const [saveDefaultBusy, setSaveDefaultBusy] = useState(false);
    const [taqeemConflict, setTaqeemConflict] = useState(null);
    const [taqeemEverLoggedIn, setTaqeemEverLoggedIn] = usePersistentState('taqeem:ever-logged-in', false, { storage: 'session' });
    const [showTaqeemReconnect, setShowTaqeemReconnect] = useState(false);
    const [reconnectState, setReconnectState] = useState('idle');
    const [reconnectError, setReconnectError] = useState('');
    const [isDeviceMenuOpen, setIsDeviceMenuOpen] = useState(false);
    const [isLanguageMenuOpen, setIsLanguageMenuOpen] = useState(false);
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = usePersistentState(
        'valtech:uploadSidebarCollapsed',
        false,
    );
    const [isMobileNavExpanded, setIsMobileNavExpanded] = useState(false);
    const [viewportWidth, setViewportWidth] = useState(
        typeof window !== 'undefined' ? window.innerWidth : 1440
    );
    const reconnectCloseTimerRef = useRef(null);
    const prevTaqeemStateRef = useRef(taqeemStatus?.state);
    const authorizeAttemptRef = useRef('');
    const deviceMenuRef = useRef(null);
    const languageMenuRef = useRef(null);
    const taqeemLoggedIn = taqeemStatus?.state === 'success';
    const taqeemCompanyContextKey = String(
        getCompanySelectionKey(selectedCompany) ||
        defaultCompanyOfficeId ||
        user?.defaultCompanyOfficeId ||
        user?.taqeem?.defaultCompanyOfficeId ||
        preferredCompanyKey ||
        ''
    ).trim();
    const hasCompanyContextForTaqeem = Boolean(taqeemCompanyContextKey);
    const requiresInitialTaqeemConnection = Boolean(
        isAuthenticated &&
        hasCompanyContextForTaqeem &&
        !taqeemLoggedIn &&
        !taqeemConflict
    );

    useEffect(() => {
        // Reset notice dismissal whenever a new update arrives
        setHideUpdateNotice(false);
    }, [latestUpdate]);

    useEffect(() => {
        if (selectedCompany) {
            setCompanyModalSelection(getCompanySelectionKey(selectedCompany));
        }
    }, [selectedCompany]);

    useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        const handleResize = () => setViewportWidth(window.innerWidth);
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    useEffect(() => {
        if (!isDeviceMenuOpen && !isLanguageMenuOpen) return undefined;

        const handlePointerDown = (event) => {
            const target = event?.target;
            if (
                isDeviceMenuOpen &&
                deviceMenuRef.current &&
                !deviceMenuRef.current.contains(target)
            ) {
                setIsDeviceMenuOpen(false);
            }
            if (
                isLanguageMenuOpen &&
                languageMenuRef.current &&
                !languageMenuRef.current.contains(target)
            ) {
                setIsLanguageMenuOpen(false);
            }
        };

        window.addEventListener('mousedown', handlePointerDown);
        window.addEventListener('touchstart', handlePointerDown);
        return () => {
            window.removeEventListener('mousedown', handlePointerDown);
            window.removeEventListener('touchstart', handlePointerDown);
        };
    }, [isDeviceMenuOpen, isLanguageMenuOpen]);

    useEffect(() => {
        if (!isAuthenticated) {
            setShowTaqeemReconnect(false);
            setReconnectState('idle');
            setReconnectError('');
            setTaqeemEverLoggedIn(false);
            return;
        }

        const currentState = taqeemStatus?.state;
        const previousState = prevTaqeemStateRef.current;
        prevTaqeemStateRef.current = currentState;

        if (currentState === 'success') {
            if (!taqeemEverLoggedIn) {
                setTaqeemEverLoggedIn(true);
            }
            if (showTaqeemReconnect && reconnectState !== 'success') {
                setReconnectState('success');
                if (reconnectCloseTimerRef.current) {
                    clearTimeout(reconnectCloseTimerRef.current);
                }
                reconnectCloseTimerRef.current = setTimeout(() => {
                    setShowTaqeemReconnect(false);
                    setReconnectState('idle');
                    setReconnectError('');
                }, 1200);
            }
            return;
        }

        if (requiresInitialTaqeemConnection) {
            setShowTaqeemReconnect(true);
            if (!showTaqeemReconnect || previousState === 'success') {
                setReconnectState('idle');
                setReconnectError('');
            }
            return;
        }

        if (taqeemEverLoggedIn && currentState !== 'success') {
            setShowTaqeemReconnect(true);
            if (previousState === 'success') {
                setReconnectState('idle');
                setReconnectError('');
            }
        }
    }, [
        isAuthenticated,
        reconnectState,
        requiresInitialTaqeemConnection,
        setTaqeemEverLoggedIn,
        showTaqeemReconnect,
        taqeemEverLoggedIn,
        taqeemStatus?.state
    ]);

    useEffect(() => () => {
        if (reconnectCloseTimerRef.current) {
            clearTimeout(reconnectCloseTimerRef.current);
        }
    }, []);

    useEffect(() => {
        if (reconnectState !== 'success' || !showTaqeemReconnect) return;
        if (reconnectCloseTimerRef.current) {
            clearTimeout(reconnectCloseTimerRef.current);
        }
        reconnectCloseTimerRef.current = setTimeout(() => {
            setShowTaqeemReconnect(false);
            setReconnectState('idle');
            setReconnectError('');
        }, 1200);
    }, [reconnectState, showTaqeemReconnect]);

    useEffect(() => {
        if (!isAuthenticated || !token || !window?.electronAPI?.apiRequest) return;

        const authKey = [
            user?._id || user?.id || user?.userId || user?.phone || 'user',
            taqeemCompanyContextKey || 'no-company'
        ].join(':');
        if (authorizeAttemptRef.current === authKey) return;
        authorizeAttemptRef.current = authKey;

        void window.electronAPI.apiRequest(
            'POST',
            '/api/users/authorize',
            { assetCount: 0 },
            { Authorization: `Bearer ${token}` }
        ).catch((err) => {
            console.warn('Background Taqeem authorization failed:', err?.message || err);
        });
    }, [
        isAuthenticated,
        taqeemCompanyContextKey,
        token,
        user?._id,
        user?.id,
        user?.phone,
        user?.userId
    ]);

    useEffect(() => {
        if (typeof window === 'undefined' || !window?.addEventListener) return undefined;

        const onTaqeemConflict = (event) => {
            const detail = event?.detail || {};
            const taqeemUser = String(
                detail?.taqeemUser ||
                detail?.username ||
                ''
            ).trim();
            const conflictMessage = taqeemUser
                ? `This Taqeem username (${taqeemUser}) is already used before. Please login to the system.`
                : (detail?.message || 'This Taqeem user is already linked to another Value Tech account. Please login to the system.');
            const conflictReason = String(detail?.reason || '').toUpperCase();
            if (conflictReason === 'SYSTEM_LOGIN_REQUIRED') {
                setTaqeemStatus('success', 'Taqeem login: On');
            } else {
                setTaqeemStatus('error', detail?.message || 'Taqeem user is already linked');
            }
            setTaqeemConflict({
                message: conflictMessage,
                status: detail?.status || 'TAQEEM_ALREADY_USED',
                existingUserId: detail?.existingUserId || null,
                taqeemUser: taqeemUser || null
            });
            setShowTaqeemReconnect(false);
            setReconnectState('idle');
            setReconnectError('');
            setActiveGroup(null);
            setActiveTab(null);
            resetNavigation();
        };

        window.addEventListener(TAQEEM_CONFLICT_EVENT, onTaqeemConflict);
        return () => {
            window.removeEventListener(TAQEEM_CONFLICT_EVENT, onTaqeemConflict);
        };
    }, [onViewChange, resetNavigation, setActiveGroup, setActiveTab, setTaqeemStatus]);

    useEffect(() => {
        // Start RAM polling when component mounts
        if (isRamAvailable) {
            startPolling(5000);
        }

        // Cleanup when component unmounts
        return () => {
            stopPolling();
        };
    }, [startPolling, stopPolling, isRamAvailable]);

    useEffect(() => {
        const fetchBackendVersion = async () => {
            try {
                const healthData = await getHealth();
                if (healthData && healthData.data.version) {
                    setBackendVersion(healthData.data.version);
                }
            } catch (error) {
                console.error('Failed to fetch backend version:', error);
                setBackendVersion(null);
            }
        };

        fetchBackendVersion();
    }, []); // Empty dependency array to run only once on mount

    useEffect(() => {
        if (!systemState || (!systemState.downtimeDays && !systemState.expectedReturn && !systemState.downtimeHours)) {
            setDowntimeParts(null);
            return;
        }

        const msFromDays = Number(systemState.downtimeDays || 0) * 24 * 60 * 60 * 1000;
        const msFromHours = Number(systemState.downtimeHours || 0) * 60 * 60 * 1000;

        // Prefer explicit hours if provided, otherwise fall back to days
        const durationMs = msFromHours > 0 ? msFromHours : msFromDays;

        const target = systemState.expectedReturn
            ? new Date(systemState.expectedReturn).getTime()
            : durationMs > 0
                ? new Date(systemState.updatedAt || Date.now()).getTime() + durationMs
                : null;

        if (!target || Number.isNaN(target)) {
            setDowntimeParts(null);
            return;
        }

        if (Number.isNaN(target)) {
            setDowntimeParts(null);
            return;
        }

        const formatRemaining = (ms) => {
            if (ms <= 0) {
                return {
                    label: '00:00:00',
                    days: '00',
                    hours: '00',
                    minutes: '00',
                    seconds: '00'
                };
            }
            const totalSeconds = Math.floor(ms / 1000);
            const days = Math.floor(totalSeconds / 86400);
            const hours = Math.floor((totalSeconds % 86400) / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            const pad = (v) => String(v).padStart(2, '0');
            return {
                label: `${pad(days)}d ${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`,
                days: pad(days),
                hours: pad(hours),
                minutes: pad(minutes),
                seconds: pad(seconds)
            };
        };

        const updateCountdown = () => {
            const now = Date.now();
            const formatted = formatRemaining(target - now);
            setDowntimeParts(formatted);
        };

        updateCountdown();
        const id = setInterval(updateCountdown, 1000);
        return () => clearInterval(id);
    }, [systemState]);

    const requireAuth = () => {
        if (!isAuthenticated) {
            alert(t('layout.alerts.loginToManageUpdates'));
            return false;
        }
        return true;
    };

    const handleDownloadUpdate = async () => {
        if (!latestUpdate) return;
        if (!requireAuth()) return;
        try {
            await markDownloaded(latestUpdate._id);
            alert(t('layout.alerts.updateDownloadPrepared'));
        } catch (err) {
            const msg = err?.response?.data?.message || err.message || t('layout.alerts.downloadUpdateFailed');
            alert(msg);
        }
    };

    const handleApplyUpdate = async () => {
        if (!latestUpdate) return;
        if (!requireAuth()) return;
        try {
            await applyUpdate(latestUpdate._id);
            alert(t('layout.alerts.updateApplied'));
        } catch (err) {
            const msg = err?.response?.data?.message || err.message || t('layout.alerts.applyUpdateFailed');
            alert(msg);
        }
    };

    const isMandatoryUpdate = latestUpdate?.rolloutType === 'mandatory';
    const shouldShowUpdateNotice = isAuthenticated && !isAdmin && latestUpdate && userUpdateState?.status !== 'applied' && !hideUpdateNotice;

    const reconnectBusy = reconnectState === 'opening' || reconnectState === 'waiting-login';
    const taqeemLoginClickable = !taqeemLoggedIn && !reconnectBusy;
    const reconnectMessage = useMemo(() => {
        if (reconnectState === 'opening') {
            return t('taqeemReconnect.connecting', { defaultValue: 'Opening Taqeem browser...' });
        }
        if (reconnectState === 'waiting-login') {
            return t('taqeemReconnect.waitingLogin', {
                defaultValue: 'Taqeem browser is open. Complete login if required; the app will switch to On automatically.'
            });
        }
        if (reconnectState === 'success') {
            return t('taqeemReconnect.success', { defaultValue: 'Reconnected to Taqeem successfully.' });
        }
        if (reconnectState === 'error') {
            return reconnectError || t('taqeemReconnect.error', { defaultValue: 'Taqeem login failed. Please try again.' });
        }
        if (requiresInitialTaqeemConnection) {
            return t('taqeemReconnect.requiredMessage', {
                defaultValue: 'Connect to Taqeem first. The app will open Taqeem home if your session exists, otherwise it will open Taqeem login.'
            });
        }
        return t('taqeemReconnect.message', { defaultValue: 'Your Taqeem session is off. Reconnect to continue.' });
    }, [reconnectError, reconnectState, requiresInitialTaqeemConnection, t]);
    const buildNumber = useMemo(() => buildVersion.build, []);


    const handleCompanyChange = async (value) => {
        if (!value) {
            await setSelectedCompany(null, { skipNavigation: true });
            return;
        }
        const company = companies?.find((c) => getCompanySelectionKey(c) === value);
        if (company) {
            await setSelectedCompany(company, { skipNavigation: true });
        }
    };

    const handleCompanyModalSubmit = async () => {
        if (!companyModalSelection) return;
        const company = companies?.find((c) => getCompanySelectionKey(c) === companyModalSelection);
        if (!company) return;
        setCompanyModalBusy(true);
        try {
            await setSelectedCompany(company, { skipNavigation: true });
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.setItem(POST_FETCH_COMPANY_MODAL_DISMISSED, '1');
            }
            setPostFetchCompanyModalOpen(false);
        } finally {
            setCompanyModalBusy(false);
        }
    };

    const handleDismissPostFetchCompanyModal = () => {
        if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem(POST_FETCH_COMPANY_MODAL_DISMISSED, '1');
        }
        setPostFetchCompanyModalOpen(false);
    };

    const handleRefreshCompaniesClick = async () => {
        const result = await refreshCompaniesFromTaqeem?.();
        const taqeemOn = taqeemStatus?.state === 'success';
        if (!result?.ok || !taqeemOn) {
            return;
        }
        const count = Number(result?.count);
        if (!Number.isFinite(count) || count <= 0) {
            return;
        }
        if (
            typeof sessionStorage !== 'undefined' &&
            sessionStorage.getItem(POST_FETCH_COMPANY_MODAL_DISMISSED) !== '1'
        ) {
            setPostFetchCompanyModalOpen(true);
            setCompanyModalSelection(getCompanySelectionKey(selectedCompany) || '');
        }
    };

    const handleSavePreferredCompanyFromModal = async () => {
        const company = companies?.find((c) => getCompanySelectionKey(c) === companyModalSelection);
        if (!company) return;
        setSaveDefaultBusy(true);
        try {
            await setPreferredCompany(company, {
                applySelection: true,
                skipNavigation: true,
                persistDefault: true
            });
            await setSelectedCompany(company, { skipNavigation: true });
        } finally {
            setSaveDefaultBusy(false);
        }
    };

    const waitForTaqeemConnection = async (timeoutMs = 340000) => {
        if (!window?.electronAPI?.checkStatus) {
            throw new Error('Taqeem status check unavailable.');
        }

        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            const status = await window.electronAPI.checkStatus();
            const statusCode = String(status?.status || '').toUpperCase();
            if (status?.browserOpen && statusCode.includes('SUCCESS')) {
                return status;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        throw new Error(t('taqeemReconnect.error', { defaultValue: 'Taqeem login failed. Please try again.' }));
    };

    const handleReconnectToTaqeem = async () => {
        if (reconnectBusy) return;
        if (!window?.electronAPI?.openTaqeemLogin || !window?.electronAPI?.checkStatus) {
            setReconnectError(t('taqeemReconnect.unavailable', { defaultValue: 'Desktop integration unavailable. Restart the app.' }));
            setReconnectState('error');
            return;
        }

        setReconnectError('');
        setReconnectState('opening');
        try {
            const openResult = await window.electronAPI.openTaqeemLogin({
                url: TAQEEM_HOME_URL,
                automationOnly: true,
                openInAutomation: true,
                onlyIfClosed: false,
                navigateIfOpen: true,
                skipStatusCheck: true,
                preferChrome: false
            });

            if (openResult?.status !== 'SUCCESS') {
                setReconnectError(openResult?.error || t('taqeemReconnect.error', { defaultValue: 'Taqeem login failed. Please try again.' }));
                setReconnectState('error');
                return;
            }

            setReconnectState('waiting-login');
            await waitForTaqeemConnection();

            setTaqeemStatus('success', 'Taqeem login: On');
            setReconnectState('success');

            if (token && window?.electronAPI?.apiRequest) {
                void window.electronAPI.apiRequest(
                    'POST',
                    '/api/users/authorize',
                    { assetCount: 0 },
                    { Authorization: `Bearer ${token}` }
                ).catch((err) => {
                    console.warn('Post-login Taqeem authorization failed:', err?.message || err);
                });
            }

            if (refreshCompaniesFromTaqeem && (!companies || companies.length === 0)) {
                void refreshCompaniesFromTaqeem().catch((err) => {
                    console.warn('Refreshing companies after Taqeem reconnect failed:', err);
                });
            }
        } catch (err) {
            setReconnectError(err?.message || t('taqeemReconnect.error', { defaultValue: 'Taqeem login failed. Please try again.' }));
            setReconnectState('error');
        }
    };

    const showCompanyModal = postFetchCompanyModalOpen && taqeemLoggedIn && !taqeemConflict;
    const isModalSelectionDefault = Boolean(
        companyModalSelection &&
        preferredCompanyKey &&
        companyModalSelection === String(preferredCompanyKey)
    );

    const updateNotice = shouldShowUpdateNotice ? (
        <div className="relative mb-2 overflow-hidden rounded-2xl border border-slate-800/80 bg-slate-950/60 px-4 py-2.5 text-[10px] text-slate-200 shadow-[0_10px_24px_rgba(2,6,23,0.45)]">
            <div className="pointer-events-none absolute -right-8 -top-10 h-24 w-24 rounded-full bg-cyan-500/20 blur-3xl" />
            <div className="pointer-events-none absolute bottom-0 left-8 h-20 w-20 rounded-full bg-blue-500/15 blur-3xl" />
            <div className="relative flex flex-col gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-white shadow-sm">
                        <Bell className="w-3.5 h-3.5" />
                    </span>
                    <span className="font-semibold text-[11px] text-slate-100">{t('layout.updateNotice.title')}</span>
                    <span className="text-[9px] px-2 py-0.5 rounded-full bg-slate-900/70 border border-slate-700 text-slate-200">
                        {latestUpdate.version}
                    </span>
                    <span className="text-[9px] px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-200 border border-cyan-400/30">
                        {latestUpdate.updateType}
                    </span>
                </div>
                <div className="text-[10px] text-slate-300">
                    {latestUpdate.description || latestUpdate.notes || t('layout.updateNotice.descriptionFallback')}
                </div>
                {isRamAvailable ? (
                    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-700/80 bg-slate-900/55 px-2.5 py-1.5 text-[10px] text-slate-200">
                        <HardDrive className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
                        <span className="min-w-0 flex-1">
                            {ramInfo
                                ? `${t('layout.nav.memoryRead')}: ${formatNumber(ramInfo.usedGb)}/${formatNumber(ramInfo.totalGb)} GB`
                                    + ` · ${t('layout.ram.recommendedTabs')}: ${formatNumber(ramInfo.recommendedTabs)}`
                                : t('layout.ram.unavailable')}
                        </span>
                        <button
                            type="button"
                            onClick={() => readRam()}
                            disabled={readingRam}
                            className="shrink-0 rounded-lg border border-slate-600/80 bg-slate-800/80 px-2 py-0.5 text-[9px] font-semibold text-slate-100 hover:border-slate-500 disabled:opacity-50"
                        >
                            {readingRam ? <Loader2 className="h-3 w-3 animate-spin inline" /> : null}
                            {t('layout.ram.refreshTitle')}
                        </button>
                    </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                    <button
                        onClick={handleDownloadUpdate}
                        className="inline-flex items-center gap-1.5 rounded-full bg-cyan-600 px-3 py-1 text-[10px] font-semibold text-white hover:bg-cyan-500"
                        disabled={loadingUpdate}
                    >
                        <Download className="w-3.5 h-3.5" />
                        {userUpdateState?.status === 'downloaded' ? t('layout.updateNotice.downloaded') : t('layout.updateNotice.download')}
                    </button>
                    {!isMandatoryUpdate && (
                        <button
                            onClick={() => setHideUpdateNotice(true)}
                            className="inline-flex items-center gap-1.5 rounded-full bg-slate-900/70 px-3 py-1 text-[10px] font-semibold text-slate-200 border border-slate-700 hover:border-slate-600"
                            disabled={loadingUpdate}
                        >
                            {t('layout.updateNotice.later')}
                        </button>
                    )}
                    {userUpdateState?.status === 'downloaded' && (
                        <button
                            onClick={handleApplyUpdate}
                            className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-3 py-1 text-[10px] font-semibold text-white hover:bg-emerald-500"
                            disabled={loadingUpdate || userUpdateState?.status === 'applied'}
                        >
                            <ShieldCheck className="w-3.5 h-3.5" />
                            {userUpdateState?.status === 'applied' ? t('layout.updateNotice.applied') : t('layout.updateNotice.apply')}
                        </button>
                    )}
                </div>
            </div>
        </div>
    ) : null;

    const statusBanner = (
        <div className="flex items-center gap-2 text-[10px] text-slate-300 text-compact">
            <span className={`text-[9px] font-semibold px-2 py-1 rounded-full uppercase border ${mode === 'active'
                ? 'bg-emerald-500/15 text-emerald-200 border-emerald-400/30'
                : mode === 'partial'
                    ? 'bg-amber-500/15 text-amber-200 border-amber-400/30'
                    : 'bg-rose-500/15 text-rose-200 border-rose-400/30'
                }`}>
                {modeLabel}
            </span>
            {systemState?.notes && (
                <span className="text-[10px] text-slate-400 truncate">{systemState.notes}</span>
            )}
            <button
                onClick={fetchSystemState}
                className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-300 hover:text-white"
                disabled={loadingState}
                title={t('layout.status.refreshTitle')}
            >
                <RefreshCcw className="w-3.5 h-3.5" />
                {t('layout.status.refresh')}
            </button>
        </div>
    );

    const handleAuthNav = (view) => {
        setActiveGroup(null);
        setActiveTab(null);
        resetNavigation();
        setIsSidebarOpen(false);
        setIsMobileNavExpanded(false);
        if (onViewChange) onViewChange(view);
    };

    const currentLangCode = i18n.language?.startsWith('ar') ? 'ar' : 'en';
    const isCompactNav = viewportWidth < 1650;
    const isUltraCompactNav = viewportWidth < 1450;
    const isSidebarOverlay = viewportWidth < 1200;
    const isMobileNav = viewportWidth < 980;
    const betaVersionLabel = currentLangCode === 'ar' ? 'نسخة بيتا 1.0.0' : 'Beta v1.0.0';
    const sidebarDrawerEdge = uiDir === 'rtl' ? 'right-0' : 'left-0';
    const sidebarDrawerHidden = uiDir === 'rtl' ? 'translate-x-full' : '-translate-x-full';

    /* Stacking: header z-100, tabs z-99; sidebar overlay z-300/310; app modals z-400. */

    const userDisplayName = useMemo(() => {
        if (!user) return '';
        const phoneStr = user.phone != null ? String(user.phone) : '';
        const isFixedAppUser =
            phoneStr === LOCAL_APP_USER_PHONE ||
            String(user.id ?? '') === LOCAL_APP_USER_PHONE;
        if (isFixedAppUser) {
            return t('layout.nav.fixedAppUser', {
                defaultValue: currentLangCode === 'ar' ? 'مستخدم التطبيق (٠٠٠)' : 'App user (000)'
            });
        }
        if (isGuest) {
            return t('layout.nav.guestUser', { defaultValue: 'Guest' });
        }
        const raw =
            user.name ||
            user.displayName ||
            user.fullName ||
            user.taqeemUser ||
            user.taqeem?.username ||
            user.phone ||
            user.email ||
            '';
        const s = String(raw).trim();
        return s || t('layout.nav.userFallback', { defaultValue: 'User' });
    }, [user, isGuest, t, currentLangCode]);

    /** رقم الهاتف للعرض بجانب تغيير اللغة (اتجاه LTR للأرقام). */
    const userProfilePhone = useMemo(() => {
        if (!user) return '';
        const p = user.phone != null ? String(user.phone).trim() : '';
        return p || '';
    }, [user]);

    useEffect(() => {
        if (!isSidebarOverlay) {
            setIsSidebarOpen(false);
        }
        if (!isMobileNav) {
            setIsMobileNavExpanded(false);
        }
    }, [isSidebarOverlay, isMobileNav]);

    useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        if (!isSidebarOpen && !isMobileNavExpanded) return undefined;
        const handleEscape = (event) => {
            if (event?.key !== 'Escape') return;
            setIsSidebarOpen(false);
            setIsMobileNavExpanded(false);
            setIsDeviceMenuOpen(false);
            setIsLanguageMenuOpen(false);
        };
        window.addEventListener('keydown', handleEscape);
        return () => window.removeEventListener('keydown', handleEscape);
    }, [isSidebarOpen, isMobileNavExpanded]);

    const handleOpenSettingsFromUserChip = () => {
        setIsDeviceMenuOpen(false);
        setIsLanguageMenuOpen(false);
        setIsSidebarOpen(false);
        setIsMobileNavExpanded(false);
        if (onViewChange) {
            onViewChange('system-settings');
        }
    };

    const handleLanguageChange = (langCode) => {
        if (!langCode || langCode === currentLangCode) return;
        i18n.changeLanguage(langCode);
        setIsLanguageMenuOpen(false);
    };

    const handleGoProfile = () => {
        setActiveGroup('settings');
        setActiveTab('profile');
        setIsSidebarOpen(false);
        setIsMobileNavExpanded(false);
        if (onViewChange) {
            onViewChange('profile');
        }
    };

    const handleConflictGoToLogin = () => {
        if (typeof window !== 'undefined' && window?.sessionStorage && currentView) {
            if (currentView !== 'login' && currentView !== 'registration') {
                try {
                    window.sessionStorage.setItem('taqeem:returnView', JSON.stringify(currentView));
                } catch (err) {
                    // ignore storage failures
                }
            }
        }
        if (typeof window !== 'undefined' && window?.sessionStorage && isGuest) {
            try {
                const guestUserId = user?._id || user?.id || user?.userId || null;
                const guestTaqeemUser =
                    user?.taqeemUser ||
                    user?.taqeem?.username ||
                    taqeemConflict?.taqeemUser ||
                    null;
                if (guestUserId) {
                    window.sessionStorage.setItem(
                        'taqeem:guestUserIdForLink',
                        JSON.stringify(String(guestUserId))
                    );
                }
                if (guestTaqeemUser) {
                    window.sessionStorage.setItem(
                        'taqeem:guestUserForLink',
                        JSON.stringify(String(guestTaqeemUser))
                    );
                }
            } catch (err) {
                // ignore storage failures
            }
        }
        setTaqeemConflict(null);
        setShowTaqeemReconnect(false);
        setReconnectState('idle');
        setReconnectError('');
        setIsSidebarOpen(false);
        setIsMobileNavExpanded(false);
        setActiveGroup(null);
        setActiveTab(null);
        resetNavigation();
        if (isGuest) {
            logout();
        }
        if (onViewChange) {
            onViewChange(DEFAULT_HOME_VIEW);
        }
    };

    const handleLogout = () => {
        setActiveGroup(null);
        setActiveTab(null);
        resetAll();
        setIsSidebarOpen(false);
        setIsMobileNavExpanded(false);
        logout();
        if (onViewChange) {
            onViewChange(DEFAULT_HOME_VIEW);
        }
    };

    const currentTabInfo = findTabInfo(currentView);
    const resolvedGroupId = activeGroup || currentTabInfo?.groupId || null;
    const resolvedGroup = resolvedGroupId ? valueSystemGroups[resolvedGroupId] : null;
    const resolvedGroupLabel = resolvedGroup
        ? t(`navigation.groups.${resolvedGroupId}.title`, { defaultValue: resolvedGroup.title })
        : null;
    const headerTitle = (() => {
        if (currentTabInfo?.tab?.id) {
            return t(`navigation.tabs.${currentTabInfo.tab.id}.label`, {
                defaultValue: currentTabInfo.tab.label
            });
        }
        if (isValueSystemView(currentView) && resolvedGroupLabel) {
            return resolvedGroupLabel;
        }
        const viewTitle = viewTitles[currentView];
        if (viewTitle) {
            return t(`navigation.viewTitles.${currentView}`, { defaultValue: viewTitle });
        }
        return t('layout.header.defaultTitle');
    })();
    const groupTabs = (() => {
        const tabs = filterTabsByAccess(resolvedGroup?.tabs || [], user);
        return tabs;
    })();
    const isValueView = isValueSystemView(currentView);
    const showHeaderTabs = isValueView && groupTabs.length > 0;
    const tabLabel = currentTabInfo?.tab?.id
        ? t(`navigation.tabs.${currentTabInfo.tab.id}.label`, {
            defaultValue: currentTabInfo.tab.label
        })
        : null;
    const tabDescription = currentTabInfo?.tab?.id
        ? t(`navigation.tabs.${currentTabInfo.tab.id}.description`, {
            defaultValue: currentTabInfo.tab.description
        })
        : null;
    const heroTitle = tabLabel || resolvedGroupLabel || headerTitle;
    const heroArtLabel = resolvedGroupLabel || heroTitle;
    const heroKicker = resolvedGroupLabel && tabLabel
        ? resolvedGroupLabel
        : resolvedGroupLabel
            ? t('apps.mainLinks')
            : null;
    const heroSubtitle = tabDescription
        || (isValueSystemView(currentView) && resolvedGroupLabel ? t('apps.stage.selectTab') : '');
    const heroTheme = heroThemes[resolvedGroupId] || heroThemes.default;
    const HeroIcon = heroIcons[resolvedGroupId] || AppWindow;
    const showHero = Boolean(resolvedGroupLabel || tabLabel);
    const settingsRootTab = DEFAULT_HOME_VIEW;
    const pageBreadcrumbs = (() => {
        if (currentView === 'system-settings') {
            return [{ label: t('settingsDashboard.title'), key: 'system-settings', kind: 'view' }];
        }
        if (currentView === 'tickets') {
            return [{ label: t('sidebar.tickets'), key: 'tickets', kind: 'view' }];
        }
        if (resolvedGroupId === 'settings') {
            const items = [{ label: t('sidebar.settings'), key: 'settings', kind: 'settings' }];
            if (currentTabInfo?.tab?.id) {
                items.push({
                    label: t(`navigation.tabs.${currentTabInfo.tab.id}.label`, {
                        defaultValue: currentTabInfo.tab.label
                    }),
                    key: currentTabInfo.tab.id,
                    kind: 'view'
                });
            }
            return items;
        }
        return breadcrumbs || [];
    })();

    const handleBreadcrumbClick = (item) => {
        switch (item.kind) {
            case 'apps':
                // top-level
                onViewChange(DEFAULT_HOME_VIEW);
                break;
            case 'card':
                {
                    const cardEntry = valueSystemCards.find((card) => card.id === item.key);
                    chooseCard(item.key);
                    if (item.key === 'evaluation-sources') {
                        const evaluationTabs = valueSystemGroups.evaluationSources?.tabs || [];
                        const mainTab = evaluationTabs.find((tab) => tab.id === 'yalla-motor')?.id
                            || evaluationTabs.find((tab) => tab.id === 'haraj-scrape')?.id
                            || evaluationTabs.find((tab) => tab.id === 'haraj')?.id
                            || evaluationTabs[0]?.id
                            || 'haraj-scrape';
                        setActiveGroup('evaluationSources');
                        setActiveTab(mainTab);
                        onViewChange(mainTab);
                        break;
                    }
                    setActiveGroup(cardEntry?.defaultGroup || null);
                }
                setActiveTab(null);
                onViewChange(DEFAULT_HOME_VIEW);
                break;
            case 'domain':
                chooseCard('uploading-reports');
                chooseDomain(item.key);
                if (item.key === 'equipments') {
                    const uploadTabs = filterTabsByAccess(valueSystemGroups.uploadReports?.tabs || [], user);
                    const firstUploadTab = uploadTabs?.[0]?.id || DEFAULT_HOME_VIEW;
                    setActiveGroup('uploadReports');
                    setActiveTab(firstUploadTab);
                    onViewChange(firstUploadTab || DEFAULT_HOME_VIEW);
                } else if (item.key === 'real-estate') {
                    onViewChange(DEFAULT_HOME_VIEW);
                } else {
                    onViewChange(DEFAULT_HOME_VIEW);
                }
                break;
            case 'company':
                chooseCard('uploading-reports');
                chooseDomain('equipments');
                if (item.value) {
                    setSelectedCompany(item.value, { skipNavigation: true });
                }
                onViewChange(DEFAULT_HOME_VIEW);
                break;
            case 'group':
                {
                    if (!canAccessGroup(item.key, user)) {
                        onViewChange(DEFAULT_HOME_VIEW);
                        break;
                    }
                    const owningCard = findCardForGroup(item.key);
                    if (owningCard?.id) {
                        chooseCard(owningCard.id);
                    }
                    if (owningCard?.id === 'uploading-reports' && selectedDomain) {
                        chooseDomain(selectedDomain);
                    }
                    setActiveGroup(item.key);
                    const targetTabs = filterTabsByAccess(valueSystemGroups[item.key]?.tabs || [], user);
                    const targetFirstTab = targetTabs?.[0]?.id;
                    if (targetFirstTab) {
                        onViewChange(targetFirstTab);
                    } else {
                        onViewChange(DEFAULT_HOME_VIEW);
                    }
                }
                break;
            case 'tab':
                onViewChange(item.key);
                break;
            case 'settings':
                onViewChange(settingsRootTab);
                break;
            case 'view':
                onViewChange(item.key);
                break;
            default:
                onViewChange(DEFAULT_HOME_VIEW);
        }
    };

    const renderReportUploadTabs = () => {
        if (!showHeaderTabs) return null;
        return (
            <div className={nav.tabsBar}>
                <div className="mx-auto w-full max-w-[min(100%,1400px)] px-2.5 sm:px-3 lg:px-8">
                    <nav
                        className="flex w-full justify-center"
                        role="tablist"
                        aria-label={t('navigation.uploadRoot', { defaultValue: 'رفع التقارير' })}
                    >
                        <div className="flex w-full max-w-2xl items-end justify-center gap-1 sm:gap-6">
                            {groupTabs.map((tab) => {
                                const isActive = currentView === tab.id;
                                const isBlocked = isFeatureBlocked(tab.id);
                                const reason = isBlocked ? blockReason(tab.id) : '';
                                return (
                                    <button
                                        key={tab.id}
                                        type="button"
                                        role="tab"
                                        aria-selected={isActive}
                                        onClick={() => !isBlocked && onViewChange(tab.id)}
                                        disabled={isBlocked}
                                        title={isBlocked && reason ? reason : undefined}
                                        className={`relative min-w-0 flex-1 rounded-t-lg px-2 pb-3 pt-3 text-center text-sm font-semibold transition-colors sm:flex-none sm:px-6 sm:text-base ${isBlocked
                                            ? 'cursor-not-allowed text-slate-600'
                                            : isActive
                                                ? 'text-white'
                                                : 'text-slate-400 hover:text-slate-100'
                                            }`}
                                    >
                                        <span className="relative z-10 block truncate">
                                            {t(`navigation.tabs.${tab.id}.label`, { defaultValue: tab.label })}
                                        </span>
                                        {isActive && !isBlocked ? (
                                            <span
                                                className="pointer-events-none absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-emerald-400 sm:left-5 sm:right-5"
                                                aria-hidden
                                            />
                                        ) : null}
                                    </button>
                                );
                            })}
                        </div>
                    </nav>
                </div>
            </div>
        );
    };

    const PageChrome = () => {
        if (isValueSystemView(currentView)) return null;
        if (!pageBreadcrumbs || pageBreadcrumbs.length === 0) return null;
        return (
            <div className="mb-2 w-full">
                <div className="mx-auto w-full max-w-[min(100%,1400px)] px-4 sm:px-6 lg:px-8">
                    <div className="border-b border-neutral-200/80 bg-white/80 pb-0 backdrop-blur-md">
                        <div className="flex flex-wrap items-center gap-1 py-1.5 text-[11px] sm:text-xs">
                            <div className="flex min-h-[1.25rem] flex-wrap items-center justify-center gap-1 text-neutral-500 sm:justify-start">
                                {pageBreadcrumbs.map((item, idx) => {
                                    const isLast = idx === pageBreadcrumbs.length - 1;
                                    return (
                                        <React.Fragment key={item.key + idx}>
                                            <button
                                                type="button"
                                                onClick={() => handleBreadcrumbClick(item)}
                                                className={`inline-flex items-center px-1 py-0.5 font-medium transition-colors ${isLast
                                                    ? 'text-neutral-900'
                                                    : 'text-neutral-500 hover:text-neutral-800'
                                                    }`}
                                            >
                                                {item.label}
                                            </button>
                                            {idx < pageBreadcrumbs.length - 1 && (
                                                <span className="mx-0.5 text-neutral-300" aria-hidden>/</span>
                                            )}
                                        </React.Fragment>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    const handleSidebarViewChange = (view) => {
        if (onViewChange) {
            onViewChange(view);
        }
        if (isSidebarOverlay) {
            setIsSidebarOpen(false);
        }
        setIsMobileNavExpanded(false);
        setIsDeviceMenuOpen(false);
        setIsLanguageMenuOpen(false);
    };

    /** Top bar + chrome: slightly lighter blues (readable, less heavy than prior #0f2840 family) */
    const nav = useMemo(() => ({
        header:
            'font-sans relative z-[100] max-w-full overflow-visible bg-[#174a6e] text-slate-100 border-b border-black/10 shadow-sm',
        tabsBar:
            'font-sans relative z-[99] w-full shrink-0 bg-[#134060] text-slate-200 border-b border-black/10',
        chipRow:
            'inline-flex shrink-0 items-center gap-2 rounded-xl bg-black/15 px-2.5 py-1.5',
        chipLabel: 'text-[9px] font-semibold text-slate-400',
        ghostIcon:
            'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/10 text-slate-100',
        pill:
            'inline-flex h-9 shrink-0 items-center gap-2 rounded-xl bg-white/8 px-2.5 text-[10px] font-semibold text-slate-100 transition hover:bg-white/12 disabled:pointer-events-none disabled:opacity-45',
        field:
            'rounded-lg bg-white/10 px-2 py-1.5 text-[10px] font-semibold text-slate-100 outline-none transition focus-visible:ring-2 focus-visible:ring-emerald-400/30 focus-visible:ring-offset-0 focus-visible:ring-offset-transparent',
        /** Native select on dark header: inset panel vs lighter header blue */
        companyField:
            'appearance-none rounded-lg border border-white/25 bg-[#0c3a5a] px-2 py-1.5 pe-7 text-[10px] font-semibold text-white outline-none transition scheme-dark focus-visible:border-emerald-400/50 focus-visible:ring-2 focus-visible:ring-emerald-400/35 focus-visible:ring-offset-0',
        menuPanel:
            'rounded-xl bg-[#183a58] p-2.5 shadow-lg',
        mobileSheet:
            'mt-2 grid w-full grid-cols-1 gap-2 rounded-xl bg-[#174a6e]/98 p-2.5',
    }), []);

    const renderSystemStatusChip = () => (
        <div className={`${nav.chipRow} ${isCompactNav ? 'py-1' : ''}`}>
            <span className={`${nav.chipLabel} hidden sm:inline`}>
                {t('layout.status.systemState', {
                    defaultValue: currentLangCode === 'ar' ? 'حالة النظام' : 'System Status'
                })}
            </span>
            <span className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-0.5 text-[9px] font-semibold ${mode === 'active'
                ? 'bg-emerald-500/20 text-emerald-100'
                : mode === 'partial'
                    ? 'bg-amber-500/20 text-amber-50'
                    : 'bg-rose-500/20 text-rose-50'
                }`}>
                <CircleDot className="h-3 w-3 opacity-95" />
                {modeLabel}
            </span>
            <span className="hidden sm:inline-flex items-center rounded-lg bg-white/8 px-2 py-0.5 text-[9px] font-semibold text-slate-300">
                {betaVersionLabel}
            </span>
        </div>
    );

    const renderTaqeemControl = () => (
        <button
            type="button"
            onClick={taqeemLoginClickable ? handleReconnectToTaqeem : undefined}
            disabled={!taqeemLoginClickable}
            title={!taqeemLoggedIn
                ? t('taqeemReconnect.action', { defaultValue: 'Connect to Taqeem' })
                : t('taqeemReconnect.success', { defaultValue: 'Reconnected to Taqeem successfully.' })}
            className={`${nav.pill} ${isCompactNav ? 'gap-1.5 px-2' : ''} ${taqeemLoggedIn
                ? 'cursor-default bg-emerald-500/12 text-emerald-50'
                : taqeemLoginClickable
                    ? 'cursor-pointer'
                    : ''
                }`}
        >
            <span className={nav.ghostIcon}>
                {!taqeemLoggedIn && reconnectBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-100" />
                ) : (
                    <ShieldCheck className="h-3.5 w-3.5" />
                )}
            </span>
            {!isUltraCompactNav && t('layout.status.taqeem', { defaultValue: 'Taqeem' })}
            <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] font-semibold ${taqeemLoggedIn
                ? 'bg-black/20 text-emerald-100'
                : 'bg-rose-500/15 text-rose-50'
                }`}>
                <CircleDot className="h-2.5 w-2.5" />
                {taqeemLoggedIn
                    ? t('layout.status.on', { defaultValue: 'On' })
                    : t('layout.status.off', { defaultValue: 'Off' })}
            </span>
        </button>
    );

    const renderCompanyControl = () => (
        <div className={`flex min-h-9 flex-wrap items-center gap-2 rounded-xl bg-white/7 px-2 py-1.5 ${isCompactNav ? 'px-2' : 'px-2.5'}`}>
            <span className={nav.ghostIcon}>
                <Building2 className="h-3.5 w-3.5" />
            </span>
            {!isUltraCompactNav && (
                <span className="text-[9px] font-semibold text-slate-400">
                    {t('layout.status.company', { defaultValue: 'Company' })}
                </span>
            )}
            <div className="relative min-w-0 shrink-0">
                <select
                    value={getCompanySelectionKey(selectedCompany)}
                    onChange={(e) => handleCompanyChange(e.target.value)}
                    className={`${nav.companyField} max-w-[100%] ${isUltraCompactNav
                        ? 'w-[118px]'
                        : isCompactNav
                            ? 'w-[145px]'
                            : 'w-[190px]'
                        }`}
                >
                    <option value="">
                        {t('layout.status.companyDefault', { defaultValue: 'No company selected' })}
                    </option>
                    {(companies || []).map((company) => (
                        <option
                            key={getCompanySelectionKey(company)}
                            value={getCompanySelectionKey(company)}
                        >
                            {company.name || t('sidebar.company.fallback')}
                        </option>
                    ))}
                </select>
                <span
                    className="pointer-events-none absolute inset-y-0 end-0 flex items-center pe-1.5 text-slate-400"
                    aria-hidden
                >
                    <span className="text-[9px] leading-none">▾</span>
                </span>
            </div>
            <button
                type="button"
                onClick={handleRefreshCompaniesClick}
                disabled={loadingCompanies}
                title={t('navigation.fetchCompaniesButton', { defaultValue: 'جلب وتحديث الشركات' })}
                className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg bg-white/10 px-2 text-[9px] font-semibold text-slate-100 hover:bg-white/14 disabled:cursor-not-allowed disabled:opacity-50"
            >
                {loadingCompanies ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-200" />
                ) : (
                    <RefreshCcw className="h-3.5 w-3.5 text-emerald-200/90" />
                )}
                {!isUltraCompactNav && (
                    <span className="max-w-[100px] truncate text-slate-100">
                        {t('navigation.fetchCompaniesButton', { defaultValue: 'جلب وتحديث الشركات' })}
                    </span>
                )}
            </button>
        </div>
    );

    const renderDeviceMenuControl = () => (
        <div ref={deviceMenuRef} className="relative z-[200] shrink-0">
            <button
                type="button"
                onClick={() => {
                    setIsDeviceMenuOpen((prev) => !prev);
                    setIsLanguageMenuOpen(false);
                }}
                className={`${nav.pill}`}
            >
                <span className={nav.ghostIcon}>
                    <HardDrive className="h-3.5 w-3.5 text-sky-200/90" />
                </span>
                {!isUltraCompactNav && t('layout.nav.deviceCapability', {
                    defaultValue: currentLangCode === 'ar' ? 'قدرة الجهاز' : 'Device Capability'
                })}
                <ChevronDown className={`h-4 w-4 text-slate-300 transition-transform ${isDeviceMenuOpen ? 'rotate-180' : ''}`} />
            </button>
            {isDeviceMenuOpen && (
                <div
                    className={`absolute z-[300] mt-2 w-[320px] max-w-[calc(100vw-1rem)] ${nav.menuPanel}`}
                    style={uiDir === 'rtl' ? { right: 0 } : { left: 0 }}
                >
                    <div className="mb-2 flex items-center justify-between">
                        <span className="text-[10px] font-bold text-slate-100">
                            {t('layout.nav.deviceCapability', {
                                defaultValue: currentLangCode === 'ar' ? 'قدرة الجهاز' : 'Device Capability'
                            })}
                        </span>
                        <button
                            type="button"
                            onClick={readRam}
                            disabled={readingRam || !isRamAvailable}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-slate-100 hover:bg-white/14 disabled:cursor-not-allowed disabled:opacity-60"
                            title={!isRamAvailable ? t('layout.ram.unavailable') : t('layout.ram.refreshTitle')}
                        >
                            {readingRam ? (
                                <Loader2 className="h-4 w-4 animate-spin text-emerald-300" />
                            ) : (
                                <HardDrive className="h-4 w-4 text-cyan-200" />
                            )}
                        </button>
                    </div>
                    {ramError ? (
                        <div className="rounded-lg bg-rose-500/15 px-2 py-1.5 text-[10px] text-rose-100">
                            {ramError}
                        </div>
                    ) : (
                        <div className="space-y-1.5 text-[10px] text-slate-200">
                            <div className="rounded-lg bg-black/20 px-2.5 py-1.5">
                                {t('layout.nav.memoryRead', { defaultValue: 'قراءة الذاكرة' })}: {' '}
                                {ramInfo
                                    ? `${formatNumber(ramInfo.usedGb)}/${formatNumber(ramInfo.totalGb)} GB`
                                    : t('layout.ram.unavailable')}
                                {ramInfo && typeof ramInfo.freeGb === 'number'
                                    ? ` | ${formatNumber(ramInfo.freeGb)} GB`
                                    : ''}
                                {ramInfo?.usagePercentage
                                    ? ` | ${formatNumber(ramInfo.usagePercentage)}%`
                                    : ''}
                            </div>
                            <div className="rounded-lg bg-black/20 px-2.5 py-1.5">
                                {t('layout.ram.recommendedTabs', { defaultValue: 'التابات الموصى بها' })}: {' '}
                                {ramInfo?.recommendedTabs != null
                                    ? formatNumber(ramInfo.recommendedTabs)
                                    : '--'}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );

    const renderLanguageMenuControl = () => (
        <div ref={languageMenuRef} className="relative z-[200] shrink-0">
            <button
                type="button"
                onClick={() => {
                    setIsLanguageMenuOpen((prev) => !prev);
                    setIsDeviceMenuOpen(false);
                }}
                className={`${nav.pill}`}
            >
                <span className="inline-flex min-w-[2.25rem] items-center justify-center rounded-lg bg-white/10 px-2 py-1 text-[9px] font-bold tracking-wide text-emerald-50">
                    {currentLangCode.toUpperCase()}
                </span>
                <ChevronDown className={`h-4 w-4 text-slate-300 transition-transform ${isLanguageMenuOpen ? 'rotate-180' : ''}`} />
            </button>
            {isLanguageMenuOpen && (
                <div
                    className="absolute z-[300] mt-2 w-[168px] max-w-[calc(100vw-1rem)] rounded-xl bg-[#183a58] p-1.5 shadow-lg"
                    style={uiDir === 'rtl' ? { left: 0 } : { right: 0 }}
                >
                    <button
                        type="button"
                        onClick={() => handleLanguageChange('ar')}
                        className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-[10px] font-semibold ${currentLangCode === 'ar'
                            ? 'bg-emerald-500/18 text-white'
                            : 'text-slate-300 hover:bg-white/8'
                            }`}
                    >
                        <span>AR</span>
                        <span>{t('common.arabic', { defaultValue: 'العربية' })}</span>
                    </button>
                    <button
                        type="button"
                        onClick={() => handleLanguageChange('en')}
                        className={`mt-1 flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-[10px] font-semibold ${currentLangCode === 'en'
                            ? 'bg-emerald-500/18 text-white'
                            : 'text-slate-300 hover:bg-white/8'
                            }`}
                    >
                        <span>EN</span>
                        <span>{t('common.english', { defaultValue: 'English' })}</span>
                    </button>
                </div>
            )}
        </div>
    );

    const renderUserProfileControl = () => {
        if (!user || (!userDisplayName && !userProfilePhone)) return null;
        const chipShown = userProfilePhone || userDisplayName;
        const chipTitle = userProfilePhone
            ? `${userProfilePhone} — ${userDisplayName}`
            : userDisplayName;
        const labelSettings = t('layout.nav.userChipOpenSettings');
        return (
            <button
                type="button"
                onClick={handleOpenSettingsFromUserChip}
                title={chipTitle}
                aria-label={`${labelSettings}. ${chipTitle}`}
                className={`inline-flex h-9 max-w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-white/8 px-2.5 text-[10px] font-semibold text-slate-100 transition-colors hover:bg-white/12 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/35 focus-visible:ring-offset-2 focus-visible:ring-offset-[#174a6e] ${isUltraCompactNav ? 'h-8 px-2' : ''}`}
            >
                <span className={nav.ghostIcon}>
                    <AppWindow className="h-3.5 w-3.5" />
                </span>
                <span
                    className={`max-w-[9rem] min-w-0 truncate text-slate-100 ${isUltraCompactNav ? 'text-[9px]' : 'text-[10px]'}`}
                    dir="ltr"
                    translate="no"
                >
                    {chipShown}
                </span>
            </button>
        );
    };

    const companySelectionHint = taqeemLoggedIn && companies && companies.length > 0 && !selectedCompany ? (
        <div className="inline-flex max-w-full shrink-0 items-center rounded-xl bg-amber-500/12 px-2.5 py-1.5 text-[10px] font-semibold text-amber-50">
            {t('sidebar.company.selectToContinue', { defaultValue: 'Select a company to complete uploading.' })}
        </div>
    ) : null;

    return (
        <div dir={uiDir} className="flex h-screen overflow-x-hidden bg-neutral-100 max-w-full">
            {taqeemConflict && (
                <div className="fixed inset-0 z-[400] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm px-4">
                    <div className="w-full max-w-md rounded-2xl border border-rose-200 bg-white shadow-2xl p-5 space-y-4">
                        <div className="flex items-start gap-3">
                            <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-full bg-rose-100 text-rose-700">
                                <AlertTriangle className="w-5 h-5" />
                            </div>
                            <div className="flex-1">
                                <h3 className="text-sm font-semibold text-slate-900">
                                    {t('layout.taqeemConflict.title', {
                                        defaultValue: 'Taqeem username already used'
                                    })}
                                </h3>
                                <p className="text-[11px] text-slate-600">
                                    {taqeemConflict.message}
                                </p>
                                {taqeemConflict.taqeemUser && (
                                    <p className="mt-1 text-[10px] text-slate-500">
                                        {t('layout.taqeemConflict.taqeemUsername', {
                                            defaultValue: 'Taqeem Username'
                                        })}: {taqeemConflict.taqeemUser}
                                    </p>
                                )}
                                {taqeemConflict.existingUserId && (
                                    <p className="mt-1 text-[10px] text-slate-500">
                                        {t('layout.taqeemConflict.userId', {
                                            defaultValue: 'User ID'
                                        })}: {taqeemConflict.existingUserId}
                                    </p>
                                )}
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={handleConflictGoToLogin}
                            className="w-full inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow bg-rose-600 hover:bg-rose-700"
                        >
                            {t('layout.taqeemConflict.action', {
                                defaultValue: 'Go to Value Tech Login'
                            })}
                        </button>
                    </div>
                </div>
            )}
            {showTaqeemReconnect && (
                <div className="fixed inset-0 z-[400] flex items-center justify-center bg-slate-900/70 backdrop-blur-sm px-4">
                    <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-2xl p-5 space-y-4">
                        <div className="flex items-start gap-3">
                            <div className={`mt-0.5 flex h-9 w-9 items-center justify-center rounded-full ${reconnectState === 'success'
                                ? 'bg-emerald-100 text-emerald-700'
                                : reconnectState === 'error'
                                    ? 'bg-rose-100 text-rose-700'
                                    : 'bg-amber-100 text-amber-700'
                                }`}>
                                {reconnectState === 'success' ? <ShieldCheck className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
                            </div>
                            <div className="flex-1">
                                <h3 className="text-sm font-semibold text-slate-900">
                                    {requiresInitialTaqeemConnection
                                        ? t('taqeemReconnect.requiredTitle', { defaultValue: 'Connect to Taqeem first' })
                                        : t('taqeemReconnect.title', { defaultValue: 'Taqeem connection lost' })}
                                </h3>
                                <p className={`text-[11px] ${reconnectState === 'success'
                                    ? 'text-emerald-700'
                                    : reconnectState === 'error'
                                        ? 'text-rose-700'
                                        : 'text-slate-600'
                                    }`}>
                                    {reconnectMessage}
                                </p>
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={handleReconnectToTaqeem}
                            disabled={reconnectBusy || reconnectState === 'success'}
                            className={`w-full inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow ${reconnectBusy || reconnectState === 'success'
                                ? 'bg-slate-400 cursor-not-allowed'
                                : 'bg-emerald-600 hover:bg-emerald-700'
                                }`}
                        >
                            {reconnectBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                            {reconnectState === 'opening'
                                ? t('taqeemReconnect.connecting', { defaultValue: 'Opening Taqeem browser...' })
                                : reconnectState === 'waiting-login'
                                    ? t('taqeemReconnect.waitingLoginShort', { defaultValue: 'Waiting for Taqeem login...' })
                                    : t('taqeemReconnect.action', { defaultValue: 'Connect to Taqeem' })}
                        </button>
                    </div>
                </div>
            )}
            {showCompanyModal && (
                <div className="fixed inset-0 z-[400] flex items-center justify-center bg-slate-900/70 backdrop-blur-sm px-4">
                    <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-2xl p-5 space-y-4">
                        <div className="flex items-start gap-3">
                            <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-full bg-cyan-100 text-cyan-800">
                                <Building2 className="w-5 h-5" />
                            </div>
                            <div className="flex-1">
                                <h3 className="text-sm font-semibold text-slate-900">
                                    {t('layout.companyPanel.title')}
                                </h3>
                                <p className="text-[11px] text-slate-600 leading-snug mt-1">
                                    {t('layout.companyPanel.hint')}
                                </p>
                            </div>
                        </div>
                        <div className="space-y-2">
                            <label className="text-[11px] font-semibold text-slate-800">
                                {t('layout.companyModal.label', { defaultValue: 'Companies' })}
                            </label>
                            <select
                                value={companyModalSelection}
                                onChange={(e) => setCompanyModalSelection(e.target.value)}
                                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
                            >
                                <option value="">{t('sidebar.company.selectToContinue', { defaultValue: 'Select a company' })}</option>
                                {(companies || []).map((company) => (
                                    <option key={getCompanySelectionKey(company)} value={getCompanySelectionKey(company)}>
                                        {company.name || t('sidebar.company.fallback')}
                                        {company.officeId ? ` (${t('sidebar.company.office', { officeId: company.officeId })})` : ''}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <button
                            type="button"
                            onClick={handleSavePreferredCompanyFromModal}
                            disabled={!companyModalSelection || isModalSelectionDefault || saveDefaultBusy}
                            className={`w-full inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold shadow border ${companyModalSelection && !isModalSelectionDefault && !saveDefaultBusy
                                ? 'border-emerald-500 bg-emerald-600 text-white hover:bg-emerald-700'
                                : 'border-slate-200 bg-slate-100 text-slate-400 cursor-not-allowed'
                                }`}
                        >
                            {saveDefaultBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                            {t('layout.companyPanel.setDefault')}
                        </button>
                        {isModalSelectionDefault && companyModalSelection ? (
                            <p className="text-[10px] font-medium text-emerald-700 -mt-2">
                                {t('layout.companyPanel.isDefaultNote')}
                            </p>
                        ) : null}
                        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                            <button
                                type="button"
                                onClick={handleDismissPostFetchCompanyModal}
                                className="w-full sm:w-auto inline-flex items-center justify-center rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                            >
                                {t('layout.companyModal.skip')}
                            </button>
                            <button
                                type="button"
                                onClick={handleCompanyModalSubmit}
                                disabled={!companyModalSelection || companyModalBusy}
                                className={`w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold text-white shadow ${companyModalSelection && !companyModalBusy
                                    ? 'bg-emerald-600 hover:bg-emerald-700'
                                    : 'bg-slate-400 cursor-not-allowed'
                                    }`}
                            >
                                {companyModalBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                                {companyModalBusy
                                    ? t('layout.companyModal.applying', { defaultValue: 'Applying...' })
                                    : t('layout.companyModal.action', { defaultValue: 'Select company & continue' })}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {/* Sidebar */}
            {isSidebarOverlay ? (
                <>
                    {isSidebarOpen && (
                        <button
                            type="button"
                            aria-label={currentLangCode === 'ar' ? 'إغلاق القائمة الجانبية' : 'Close sidebar'}
                            onClick={() => setIsSidebarOpen(false)}
                            className="fixed inset-0 z-[300] bg-slate-950/60 backdrop-blur-[1px]"
                        />
                    )}
                    <div
                        className={`fixed inset-y-0 ${sidebarDrawerEdge} z-[310] transform-gpu transition-transform duration-300 ${isSidebarOpen ? 'translate-x-0' : sidebarDrawerHidden} ${isSidebarOpen ? 'pointer-events-auto' : 'pointer-events-none'}`}
                    >
                        <div className="h-full w-[min(92vw,280px)] min-w-[240px] max-w-[300px]">
                            <Sidebar
                                currentView={currentView}
                                onViewChange={handleSidebarViewChange}
                                showDesktopCollapse={false}
                            />
                        </div>
                    </div>
                </>
            ) : (
                <div
                    className={`relative z-[80] h-full shrink-0 overflow-visible shadow-[4px_0_24px_rgba(15,23,42,0.08)] transition-[width] duration-200 ease-out ${
                        desktopSidebarCollapsed ? 'w-[52px]' : 'w-[260px]'
                    } max-w-[min(calc(100vw-2rem),280px)]`}
                >
                    <Sidebar
                        currentView={currentView}
                        onViewChange={onViewChange}
                        showDesktopCollapse={!desktopSidebarCollapsed}
                        onRequestCollapse={() => setDesktopSidebarCollapsed(true)}
                        railMode={desktopSidebarCollapsed}
                        onRequestExpand={() => setDesktopSidebarCollapsed(false)}
                    />
                </div>
            )}

            {/* Main Content */}
            <div className="relative z-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden max-w-full">
                {/* Header */}
                <header className={nav.header}>
                    <div className="relative px-2.5 py-2.5 sm:px-3 sm:py-3">
                        <div className="flex min-w-0 flex-wrap items-center gap-2 overflow-visible">
                            {isSidebarOverlay && (
                                <button
                                    type="button"
                                    onClick={() => setIsSidebarOpen((prev) => !prev)}
                                    aria-label={currentLangCode === 'ar' ? 'فتح القائمة الجانبية' : 'Open sidebar'}
                                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/10 text-slate-100 hover:bg-white/14"
                                >
                                    <Menu className="h-4 w-4" />
                                </button>
                            )}

                            {renderSystemStatusChip()}

                            {!isMobileNav && (
                                <>
                                    {renderTaqeemControl()}
                                    {renderCompanyControl()}
                                    {renderDeviceMenuControl()}
                                    {companySelectionHint}
                                </>
                            )}

                            <div className="ms-auto flex min-w-0 items-center gap-2">
                                {!isMobileNav && (
                                    <>
                                        {renderUserProfileControl()}
                                        {renderLanguageMenuControl()}
                                    </>
                                )}

                                {isMobileNav && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setIsMobileNavExpanded((prev) => !prev);
                                            setIsLanguageMenuOpen(false);
                                            setIsDeviceMenuOpen(false);
                                        }}
                                        className={`${nav.pill}`}
                                    >
                                        {currentLangCode === 'ar' ? 'الخيارات' : 'Controls'}
                                        <ChevronDown className={`h-4 w-4 text-slate-300 transition-transform ${isMobileNavExpanded ? 'rotate-180' : ''}`} />
                                    </button>
                                )}
                            </div>
                        </div>

                        {isMobileNav && isMobileNavExpanded && (
                            <div className={nav.mobileSheet}>
                                {renderTaqeemControl()}
                                {renderCompanyControl()}
                                <div className="flex flex-wrap items-center gap-2">
                                    {renderUserProfileControl()}
                                    {renderDeviceMenuControl()}
                                    {renderLanguageMenuControl()}
                                </div>
                                {companySelectionHint}
                            </div>
                        )}

                        {updateNotice}

                        {isAuthenticated && !isAdmin && mode === 'inactive' && (
                            <div className="mt-2 inline-flex flex-wrap items-center gap-1.5 rounded-xl bg-rose-500/12 px-2.5 py-1.5 text-[10px] font-semibold text-rose-50">
                                <AlertTriangle className="h-3.5 w-3.5" />
                                <span>{t('layout.messages.inactive')}</span>
                            </div>
                        )}
                        {isAuthenticated && !isAdmin && mode === 'partial' && (
                            <div className="mt-2 inline-flex flex-wrap items-center gap-1.5 rounded-xl bg-amber-500/12 px-2.5 py-1.5 text-[10px] font-semibold text-amber-50">
                                <AlertTriangle className="h-3.5 w-3.5" />
                                <span>{systemState?.partialMessage || t('layout.messages.partialFallback')}</span>
                            </div>
                        )}
                        {isAuthenticated && !isAdmin && mode === 'inactive' && downtimeParts && (
                            <div className="mt-2 flex flex-wrap items-center gap-1 rounded-xl bg-black/20 px-2.5 py-1.5 text-[10px] text-slate-200">
                                <AlertTriangle className="h-3.5 w-3.5 text-amber-200/90" />
                                <span className="font-bold text-slate-100">{t('layout.messages.downtimeEnds')}</span>
                                {[
                                    { label: t('layout.time.days'), value: downtimeParts.days },
                                    { label: t('layout.time.hours'), value: downtimeParts.hours },
                                    { label: t('layout.time.minutes'), value: downtimeParts.minutes },
                                    { label: t('layout.time.seconds'), value: downtimeParts.seconds }
                                ].map((item) => (
                                    <div
                                        key={item.label}
                                        className="rounded-lg bg-white/10 px-1.5 py-0.5 text-center"
                                    >
                                        <span className="font-bold text-white">{item.value}</span>
                                        <span className="ms-1 text-[9px] text-slate-400">{item.label}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                        {isAuthenticated && !isAdmin && updateBlocked() && (
                            <div className="mt-2 inline-flex flex-wrap items-center gap-1.5 rounded-xl bg-orange-500/12 px-2.5 py-1.5 text-[10px] font-semibold text-orange-50">
                                <AlertTriangle className="h-3.5 w-3.5" />
                                <span>{blockMessage || t('layout.messages.updateBlocked')}</span>
                            </div>
                        )}
                    </div>
                </header>

                {renderReportUploadTabs()}

                {/* Page Content */}
                <main className="relative flex-1 overflow-y-auto overflow-x-hidden px-0 pb-5 pt-0 max-w-full">
                    <div className="pointer-events-none absolute inset-0 z-0 bg-neutral-100" />
                    {blocked && (
                        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-[radial-gradient(circle,rgba(255,255,255,0.95),rgba(240,249,255,0.9))] backdrop-blur-sm text-center px-6">
                            <div className="flex items-center justify-center h-14 w-14 rounded-full bg-rose-50 border border-rose-100 mb-3 shadow-sm">
                                <AlertTriangle className="w-7 h-7 text-rose-500" />
                            </div>
                            <p className="text-[14px] font-semibold text-slate-900 mb-1">
                                {blockMessage || t('layout.messages.featureUnavailable')}
                            </p>
                            <p className="text-[11px] text-slate-600 mb-4">
                                {t('layout.messages.refreshOrUpdate')}
                            </p>
                        </div>
                    )}
                    <div className={`relative z-10 w-full ${blocked ? 'pointer-events-none opacity-60' : ''}`}>
                        <PageChrome />
                        <div className="mx-auto w-full max-w-[min(100%,1400px)] px-3 sm:px-5 lg:px-6 pb-4">
                            {children}
                        </div>
                    </div>
                </main>
            </div>
        </div>
    );
};

export default Layout;


