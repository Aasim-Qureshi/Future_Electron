import React, { createContext, useContext, useState, useRef, useEffect, useCallback } from 'react';
import { useSystemControl } from './SystemControlContext';
import { useSession } from './SessionContext';

const RamContext = createContext();

const DEFAULT_TABS_PER_GB = 5;

export const calculateRecommendedTabs = (freeGb, tabsPerGb = DEFAULT_TABS_PER_GB) => {
    if (freeGb == null) return 1;

    const perGb = Number(tabsPerGb);
    if (Number.isFinite(perGb) && perGb > 0) {
        return Math.max(1, Math.floor(freeGb * perGb));
    }

    const freeMb = freeGb * 1024;
    if (freeMb < 300) return 1;

    const extraTabs = Math.floor((freeMb - 300) / 200);
    return 1 + extraTabs;
};


export const useRam = () => {
    const context = useContext(RamContext);
    if (!context) {
        throw new Error('useRam must be used within RamProvider');
    }
    return context;
};

export const RamProvider = ({ children }) => {
    const { systemState } = useSystemControl();
    const { user } = useSession();
    const [ramInfo, setRamInfo] = useState(null);
    const [readingRam, setReadingRam] = useState(false);
    const [error, setError] = useState(null);
    const [lastReadTime, setLastReadTime] = useState(null);

    const ramInFlight = useRef(false);
    const pollIntervalRef = useRef(null);

    const userTabsRaw = Number(user?.workspacePreferences?.ramTabsPerGb);
    const systemTabsRaw = Number(systemState?.ramTabsPerGb);
    const tabsPerGb = Number.isFinite(userTabsRaw) && userTabsRaw > 0
        ? userTabsRaw
        : Number.isFinite(systemTabsRaw) && systemTabsRaw > 0
            ? systemTabsRaw
            : DEFAULT_TABS_PER_GB;
    const tabsPerGbSource =
        Number.isFinite(userTabsRaw) && userTabsRaw > 0
            ? 'user'
            : Number.isFinite(systemTabsRaw) && systemTabsRaw > 0
                ? 'system'
                : 'default';

    const readRam = useCallback(async () => {
        if (ramInFlight.current) return;

        if (!window?.electronAPI?.readRam) {
            setRamInfo(null);
            setError('RAM reader not available in this build.');
            return;
        }

        setReadingRam(true);
        ramInFlight.current = true;
        setError(null);

        try {
            const result = await window.electronAPI.readRam();
            if (result?.ok) {
                const recommendedTabs = calculateRecommendedTabs(result.freeGb, tabsPerGb);
                const ramData = {
                    usedGb: result.usedGb,
                    totalGb: result.totalGb,
                    freeGb: result.freeGb,
                    usagePercentage: ((result.usedGb / result.totalGb) * 100).toFixed(1),
                    recommendedTabs,
                    readAt: Date.now()
                };
                setRamInfo(ramData);
                setLastReadTime(Date.now());
                return ramData;
            } else {
                setError(result?.error || 'Unable to read RAM.');
                setRamInfo(null);
                return null;
            }
        } catch (err) {
            setError(err?.message || 'Failed to read RAM.');
            setRamInfo(null);
            return null;
        } finally {
            setReadingRam(false);
            ramInFlight.current = false;
        }
    }, [tabsPerGb]);

    useEffect(() => {
        if (!ramInfo) return;
        const recommendedTabs = calculateRecommendedTabs(ramInfo.freeGb, tabsPerGb);
        setRamInfo((prev) => {
            if (!prev || prev.recommendedTabs === recommendedTabs) return prev;
            return { ...prev, recommendedTabs };
        });
    }, [ramInfo, tabsPerGb]);

    const startPolling = useCallback((interval = 5000) => {
        // Clear existing interval
        if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
        }

        // Initial read
        readRam();

        // Set up polling
        pollIntervalRef.current = setInterval(() => {
            readRam();
        }, interval);
    }, [readRam]);

    const stopPolling = useCallback(() => {
        if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
        }
    }, []);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
            }
        };
    }, []);

    const value = {
        ramInfo,
        readingRam,
        error,
        lastReadTime,
        readRam,
        startPolling,
        stopPolling,
        isAvailable: !!window?.electronAPI?.readRam,
        tabsPerGb,
        tabsPerGbSource,
    };

    return <RamContext.Provider value={value}>{children}</RamContext.Provider>;
};

export default RamContext;
