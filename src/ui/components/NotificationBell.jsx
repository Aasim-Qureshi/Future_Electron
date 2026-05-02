import React, { useEffect, useMemo, useState } from 'react';
import { Bell, FileText, Inbox, MessageCircle, Package as PackageIcon, RefreshCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNotifications } from '../context/NotificationContext';
import { useSession } from '../context/SessionContext';
import navigation from '../constants/navigation';

const { DEFAULT_HOME_VIEW } = navigation;

const levelStyles = {
    info: 'bg-sky-400',
    success: 'bg-emerald-400',
    warning: 'bg-amber-400',
    danger: 'bg-rose-400'
};

const typeStyles = {
    ticket: {
        Icon: MessageCircle,
        className: 'bg-sky-500/20 text-sky-200 border-sky-400/30'
    },
    package: {
        Icon: PackageIcon,
        className: 'bg-indigo-500/20 text-indigo-200 border-indigo-400/30'
    },
    report: {
        Icon: FileText,
        className: 'bg-emerald-500/20 text-emerald-200 border-emerald-400/30'
    },
    system: {
        Icon: Bell,
        className: 'bg-slate-500/20 text-slate-200 border-slate-400/30'
    }
};

const getTypeStyle = (type) => typeStyles[type] || typeStyles.system;

const formatTime = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString();
};

const NotificationBell = ({ onViewChange, mode = 'unread' }) => {
    const { isAuthenticated } = useSession();
    const { t } = useTranslation();
    const {
        notifications,
        unreadCount,
        loading,
        refreshNotifications,
        markNotificationRead,
        markAllRead
    } = useNotifications();
    const [open, setOpen] = useState(false);
    const [expandedNotifications, setExpandedNotifications] = useState(new Set());

    const isInbox = mode === 'all';
    const listLimit = isInbox ? 50 : 20;
    const displayCount = useMemo(() => (unreadCount > 99 ? '99+' : unreadCount), [unreadCount]);
    const visibleNotifications = useMemo(
        () => (isInbox ? notifications : notifications.filter((item) => !item.readAt)),
        [notifications, isInbox]
    );
    const headerSubtitle = loading
        ? t('layout.notifications.loading')
        : isInbox
            ? t('layout.notifications.total', { count: notifications.length })
            : t('layout.notifications.unread', { count: unreadCount });
    const buttonTitle = isInbox ? t('layout.notifications.inboxTitle') : t('layout.notifications.newTitle');
    const ButtonIcon = isInbox ? Inbox : Bell;

    const handleToggle = () => {
        if (!isAuthenticated) return;
        setOpen((prev) => !prev);
        if (!open) {
            refreshNotifications(listLimit);
        }
    };

    const toggleNotificationExpansion = (id) => {
        setExpandedNotifications((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    useEffect(() => {
        if (!open) return;
        const handleEsc = (event) => {
            if (event.key === 'Escape') {
                setOpen(false);
            }
        };
        window.addEventListener('keydown', handleEsc);
        return () => window.removeEventListener('keydown', handleEsc);
    }, [open]);

    const openRelatedPage = (item) => {
        if (!item) return;
        const targetView = item.data?.view;
        const target = item.data?.target;
        if (target === "deduction-history") {
            localStorage.setItem(
                "notification-target",
                JSON.stringify({
                    type: "deduction-history",
                    deductionId: item.data?.deductionId || null,
                })
            );
            if (onViewChange) {
                onViewChange(targetView || DEFAULT_HOME_VIEW);
            }
            setOpen(false);
            return;
        }
        const ticketId = item.data?.ticketId;
        const requestId = item.data?.requestId;
        const reportId = item.data?.reportId;
        if (ticketId) {
            localStorage.setItem(
                'notification-target',
                JSON.stringify({
                    type: 'ticket',
                    id: ticketId
                })
            );
        } else if (requestId) {
            localStorage.setItem(
                'notification-target',
                JSON.stringify({
                    type: 'package-request',
                    id: requestId
                })
            );
        } else if (reportId) {
            localStorage.setItem(
                'notification-target',
                JSON.stringify({
                    type: 'report',
                    id: reportId
                })
            );
        }
        if (onViewChange && targetView) {
            onViewChange(targetView);
        }
        setOpen(false);
    };

    const handleNotificationClick = (item) => {
        if (!item) return;
        if (!item.readAt) {
            markNotificationRead(item._id);
        }
        openRelatedPage(item);
    };

    return (
        <div className="relative">
            <button
                type="button"
                onClick={handleToggle}
                disabled={!isAuthenticated}
                title={isAuthenticated ? buttonTitle : t('layout.notifications.loginRequired')}
                className={`relative inline-flex items-center justify-center rounded-full border px-2.5 py-1 text-[10px] font-semibold shadow-[0_10px_20px_rgba(2,6,23,0.5)] transition ${
                    open
                        ? 'border-rose-400/60 bg-rose-500/10 text-rose-100'
                        : 'border-slate-700/70 bg-slate-900/70 text-slate-100 hover:bg-slate-800'
                } disabled:opacity-60`}
            >
                <ButtonIcon className="h-4 w-4" />
                {!isInbox && unreadCount > 0 && (
                    <span className="absolute -right-1.5 -top-1 inline-flex min-w-[18px] items-center justify-center rounded-full bg-rose-500 px-1 py-0.5 text-[9px] font-bold text-white shadow">
                        {displayCount}
                    </span>
                )}
            </button>

            {open && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4 py-6">
                    <button
                        type="button"
                        onClick={() => setOpen(false)}
                        className="absolute inset-0 cursor-default"
                        aria-label={t('common.close')}
                    />
                    <div className="relative w-full max-w-md overflow-hidden rounded-3xl border border-slate-800/80 bg-slate-950 shadow-[0_30px_80px_rgba(2,6,23,0.7)]">
                        <div className="flex items-center justify-between border-b border-slate-800/70 px-5 py-3">
                            <div className="flex items-center gap-2">
                                <span className="inline-flex h-9 w-9 items-center justify-center rounded-2xl bg-rose-500/20 text-rose-200">
                                    <ButtonIcon className="h-4 w-4" />
                                </span>
                                <div>
                                    <div className="text-[12px] font-semibold text-slate-100">
                                        {buttonTitle}
                                    </div>
                                    <div className="text-[9px] text-slate-400">
                                        {headerSubtitle}
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => refreshNotifications(listLimit)}
                                    className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900/70 px-2.5 py-1 text-[9px] font-semibold text-slate-200 hover:border-slate-600"
                                >
                                    <RefreshCcw className="h-3.5 w-3.5" />
                                    {t('layout.notifications.refresh')}
                                </button>
                                <button
                                    type="button"
                                    onClick={markAllRead}
                                    disabled={unreadCount === 0}
                                    className="rounded-full border border-slate-700 bg-slate-900/70 px-2.5 py-1 text-[9px] font-semibold text-slate-200 hover:border-slate-600 disabled:opacity-50"
                                >
                                    {t('layout.notifications.markAll')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setOpen(false)}
                                    className="rounded-full border border-slate-700 bg-slate-900/70 px-2.5 py-1 text-[9px] font-semibold text-slate-200 hover:border-slate-600"
                                >
                                    {t('common.close')}
                                </button>
                            </div>
                        </div>
                        <div className="max-h-[70vh] overflow-y-auto px-4 py-4">
                            {loading && (
                                <div className="py-6 text-center text-[10px] text-slate-400">
                                    {t('layout.notifications.loading')}
                                </div>
                            )}
                            {!loading && visibleNotifications.length === 0 && (
                                <div className="py-10 text-center text-[10px] text-slate-400">
                                    {isInbox ? t('layout.notifications.emptyAll') : t('layout.notifications.emptyUnread')}
                                </div>
                            )}
                            {!loading &&
                                visibleNotifications.map((item) => {
                                    const levelClass = levelStyles[item.level] || levelStyles.info;
                                    const { Icon: TypeIcon, className: typeClass } = getTypeStyle(item.type);
                                    return (
                                        <button
                                            key={item._id}
                                            type="button"
                                            onClick={() => handleNotificationClick(item)}
                                            className={`mb-3 w-full rounded-2xl border px-3 py-2 text-left transition ${
                                                item.readAt
                                                    ? 'border-slate-800/60 bg-slate-900/60 text-slate-300'
                                                    : 'border-slate-700/70 bg-slate-900/80 text-slate-100 shadow-[0_8px_18px_rgba(2,6,23,0.35)] hover:border-rose-400/60'
                                            }`}
                                        >
                                            <div className="flex items-start gap-3">
                                                <span
                                                    className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border ${typeClass}`}
                                                >
                                                    <TypeIcon className="h-4 w-4" />
                                                </span>
                                                <div className="flex-1">
                                                    <div className="flex items-center justify-between gap-2">
                                                        <div className="flex items-center gap-2">
                                                            <span className={`h-2 w-2 rounded-full ${levelClass}`} />
                                                            <span className="text-[11px] font-semibold">
                                                                {item.title || t('layout.notifications.untitled')}
                                                            </span>
                                                        </div>
                                                        {!item.readAt && <span className="h-2 w-2 rounded-full bg-rose-500" />}
                                                    </div>
                                                        {(() => {
                                                            const isExpanded = expandedNotifications.has(item._id);
                                                            return (
                                                                <>
                                                                    <div
                                                                        className={`mt-1 text-[10px] text-slate-300 ${
                                                                            isExpanded ? "" : "line-clamp-2"
                                                                        }`}
                                                                    >
                                                                        {item.message || t("layout.notifications.untitled")}
                                                                    </div>
                                                                    <div className="mt-1 flex items-center justify-between text-[8px] text-slate-500">
                                                                        <button
                                                                            type="button"
                                                                            onClick={(event) => {
                                                                                event.stopPropagation();
                                                                                toggleNotificationExpansion(item._id);
                                                                            }}
                                                                            className="text-[9px] text-slate-400 hover:text-slate-200"
                                                                        >
                                                                            {isExpanded ? "Show less" : "Show more"}
                                                                        </button>
                                                                        <span>{formatTime(item.createdAt)}</span>
                                                                    </div>
                                                                </>
                                                            );
                                                        })()}
                                                </div>
                                            </div>
                                        </button>
                                    );
                                })}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default NotificationBell;
