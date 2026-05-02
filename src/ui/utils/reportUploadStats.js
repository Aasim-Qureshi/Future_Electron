import { clearUploadStatsRemote, recordUploadStatRemote } from '../../api/uploadStats';

const STORAGE_KEY = 'vt:report-upload-stats-v1';

const dispatchChanged = () => {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('vt:upload-stats-changed'));
    }
};

const normalizeOfficeId = (officeId) => {
    const s = String(officeId ?? '').trim();
    return s || '_unknown';
};

const emptyChannel = () => ({
    submitted: 0,
    failed: 0,
    batches: 0,
    lastAt: null
});

/**
 * @returns {Record<string, { nameHint?: string, quick: object, elrajhi: object }>}
 */
export function loadUploadStats() {
    if (typeof window === 'undefined' || !window.localStorage) return {};
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function saveUploadStats(next) {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
        /* ignore quota */
    }
    dispatchChanged();
}

function pushRemote(officeId, channel, inserted, failed, nameHint) {
    const payload = {
        officeId: officeId && officeId !== '_unknown' ? officeId : '',
        channel,
        inserted,
        failed,
        nameHint: nameHint || ''
    };
    void recordUploadStatRemote(payload).catch(() => {
        /* offline or guest — local copy already updated */
    });
}

/**
 * @param {'quick'|'elrajhi'} channel
 * @param {{ inserted?: number, failed?: number, nameHint?: string }} payload
 */
export function recordUploadBatch(officeId, channel, payload = {}) {
    const oid = normalizeOfficeId(officeId);
    const inserted = Math.max(0, Math.trunc(Number(payload.inserted) || 0));
    const failed = Math.max(0, Math.trunc(Number(payload.failed) || 0));
    if (inserted === 0 && failed === 0) return;

    const raw = loadUploadStats();
    const row = raw[oid] || {
        nameHint: payload.nameHint || '',
        quick: emptyChannel(),
        elrajhi: emptyChannel()
    };
    const bucket = channel === 'elrajhi' ? 'elrajhi' : 'quick';
    if (payload.nameHint) {
        row.nameHint = payload.nameHint;
    }
    row[bucket].submitted += inserted;
    row[bucket].failed += failed;
    row[bucket].batches += 1;
    row[bucket].lastAt = Date.now();
    raw[oid] = row;
    saveUploadStats(raw);

    pushRemote(oid, channel, inserted, failed, row.nameHint);
}

export function subscribeUploadStats(listener) {
    if (typeof window === 'undefined') return () => {};
    window.addEventListener('vt:upload-stats-changed', listener);
    return () => window.removeEventListener('vt:upload-stats-changed', listener);
}

export async function clearUploadStats() {
    if (typeof window !== 'undefined' && window.localStorage) {
        try {
            window.localStorage.removeItem(STORAGE_KEY);
        } catch {
            /* ignore */
        }
    }
    try {
        await clearUploadStatsRemote();
    } catch {
        /* guest, offline, or unauthorized */
    }
    dispatchChanged();
}
