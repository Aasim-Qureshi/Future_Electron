const { session, BrowserWindow, shell } = require('electron');
const pythonAPI = require('../../services/python/PythonAPI');

const { TAQEEM_ELECTRON_PARTITION } = require('../../shared/constants/taqeemElectronPartition');
const { getTaqeemSecondaryCredentials } = require('../../shared/constants/taqeemSecondaryCredentials');
let secondaryLoginWindow = null;
const SECONDARY_PARTITION = TAQEEM_ELECTRON_PARTITION;
const TAQEEM_APP_HOME_URL = 'https://qima.taqeem.gov.sa/';
let lastExternalLoginTs = 0;
let externalLoginInFlight = false;
let secondaryPartitionSessionWired = false;

function wireSecondaryPartitionPersistence() {
    if (secondaryPartitionSessionWired) return;
    secondaryPartitionSessionWired = true;
    try {
        const sec = session.fromPartition(SECONDARY_PARTITION);
        // persist: partition stores cookies + web storage on disk; keep cache for fewer revalidation round-trips
        sec.setCacheSize?.(200 * 1024 * 1024);
    } catch (err) {
        console.warn('[MAIN] Taqeem secondary session prefs:', err?.message || err);
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label) {
    let timer = null;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => {
                reject(new Error(`${label} timed out`));
            }, timeoutMs);
        })
    ]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

function normalizeReportIds(reports = []) {
    if (!Array.isArray(reports)) return [];

    const seen = new Set();
    const reportIds = [];
    reports.forEach((item) => {
        const raw = item && typeof item === 'object'
            ? item.reportId || item.report_id || item.reportid
            : item;
        const reportId = raw === undefined || raw === null ? '' : String(raw).trim();
        if (!reportId || seen.has(reportId)) return;
        seen.add(reportId);
        reportIds.push(reportId);
    });
    return reportIds;
}

async function confirmSingleReport(win, reportId) {
    const targetUrl = `https://qima.taqeem.gov.sa/report/${reportId}`;
    try {
        await win.loadURL(targetUrl);
    } catch (err) {
        return { status: 'FAILED', error: `Failed to load report ${reportId}: ${err?.message || err}` };
    }

    const result = await win.webContents.executeJavaScript(`
        new Promise((resolve) => {
            const deadline = Date.now() + 60000; // 60s to allow manual login if needed
            const attempt = () => {
                const checkbox = document.querySelector(
                    'input#agree, input[name="policy"], input[type="checkbox"][name*="agree"], input[type="checkbox"][id*="agree"]'
                );
                const confirmBtn = document.querySelector(
                    'input#confirm, button#confirm, input[name="confirm"], button[name="confirm"], input[type="submit"][value*="اعتماد"], button[type="submit"]'
                );
                if (checkbox && confirmBtn) {
                    try {
                        checkbox.checked = true;
                        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                        confirmBtn.disabled = false;
                        confirmBtn.removeAttribute('disabled');
                        if (typeof confirmBtn.click === 'function') {
                            confirmBtn.click();
                        } else {
                            confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                        }
                        resolve({ ok: true });
                        return;
                    } catch (err) {
                        resolve({ ok: false, error: err?.message || 'Failed clicking confirm' });
                        return;
                    }
                }
                if (Date.now() > deadline) {
                    resolve({ ok: false, error: 'Timeout waiting for checkbox/button (login required?)' });
                    return;
                }
                setTimeout(attempt, 750);
            };
            attempt();
        });
    `, true);

    await delay(1200); // brief pause after submit
    return result?.ok ? { status: 'SUCCESS' } : { status: 'FAILED', error: result?.error || 'Unknown error' };
}

async function confirmReportsBatch(win, reportIds = []) {
    if (!win || win.isDestroyed()) {
        return { total: reportIds.length, succeeded: 0, failed: reportIds.length, results: reportIds.map((id) => ({ reportId: id, status: 'FAILED', error: 'Secondary window not available' })) };
    }

    const results = [];
    for (const reportId of reportIds) {
        try {
            const res = await confirmSingleReport(win, reportId);
            results.push({ reportId, status: res.status, error: res.error });
        } catch (error) {
            results.push({ reportId, status: 'FAILED', error: error.message || String(error) });
        }
    }
    const summary = {
        total: reportIds.length,
        succeeded: results.filter((r) => r.status === 'SUCCESS').length,
        failed: results.filter((r) => r.status !== 'SUCCESS').length,
        results
    };
    return summary;
}

async function waitForSecondaryLogin(win, timeoutMs = 180000, intervalMs = 1500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (!win || win.isDestroyed()) {
            throw new Error('Secondary login window closed.');
        }
        const currentUrl = String(win.webContents.getURL() || '').toLowerCase();
        if (currentUrl.startsWith('https://qima.taqeem.gov.sa/')) {
            return true;
        }
        await delay(intervalMs);
    }
    throw new Error('Timed out waiting for Taqeem login.');
}

async function waitForNavigationStable(webContents, { stableMs = 750, timeoutMs = 45000 } = {}) {
    const start = Date.now();
    let lastUrl = '';
    while (Date.now() - start < timeoutMs) {
        if (!webContents || webContents.isDestroyed()) {
            throw new Error('Navigation target destroyed');
        }
        while (webContents.isLoading()) {
            await delay(80);
            if (Date.now() - start > timeoutMs) {
                throw new Error('Navigation timed out');
            }
        }
        await delay(stableMs);
        const u = webContents.getURL() || '';
        if (u === lastUrl) {
            return u;
        }
        lastUrl = u;
    }
    return webContents.getURL() || '';
}

function shouldOfferTaqeemLoginAssist(url) {
    const u = String(url || '').toLowerCase();
    if (u.startsWith('https://qima.taqeem.gov.sa/')) return false;
    return u.includes('sso.taqeem.gov.sa') || u.includes('openid-connect');
}

async function runTaqeemLoginAssist(webContents) {
    const { loginId, password } = getTaqeemSecondaryCredentials();
    const loginIdJson = JSON.stringify(loginId);
    const passwordJson = JSON.stringify(password);

    if (!loginId || !password) {
        console.warn(
            '[MAIN] Taqeem secondary credentials missing. Set TAQEEM_SECONDARY_LOGIN_ID and TAQEEM_SECONDARY_PASSWORD in .env (project root) and restart the app.',
        );
    }

    await webContents.executeJavaScript(`
        (function () {
            var LOGIN_ID = ${loginIdJson};
            var PASSWORD = ${passwordJson};
            function pickUser() {
                return document.querySelector(
                    'input#username, input[name="username"], input[name="login"], input[type="text"][autocomplete="username"]'
                );
            }
            function pickPass() {
                return document.querySelector(
                    'input#password, input[name="password"], input[type="password"]'
                );
            }
            var userEl = pickUser();
            var passEl = pickPass();
            if (userEl && LOGIN_ID) {
                userEl.focus();
                userEl.value = LOGIN_ID;
                userEl.dispatchEvent(new Event('input', { bubbles: true }));
                userEl.dispatchEvent(new Event('change', { bubbles: true }));
                userEl.dispatchEvent(new Event('blur', { bubbles: true }));
            }
            if (passEl && PASSWORD) {
                passEl.value = PASSWORD;
                passEl.dispatchEvent(new Event('input', { bubbles: true }));
                passEl.dispatchEvent(new Event('change', { bubbles: true }));
            }
            try {
                var scrollEl = userEl || passEl;
                if (scrollEl && scrollEl.scrollIntoView) {
                    scrollEl.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
                }
            } catch (e) { /* ignore */ }
            var HID = 'vt-taqeem-secondary-cred-panel';
            var old = document.getElementById(HID);
            if (old) old.remove();
            var panel = document.createElement('div');
            panel.id = HID;
            panel.setAttribute('dir', 'rtl');
            panel.style.cssText = [
                'position:fixed', 'bottom:0', 'left:0', 'right:0', 'z-index:2147483647',
                'font-family:system-ui,Segoe UI,Tahoma,sans-serif', 'font-size:12px',
                'background:#1a2744', 'color:#e8eefc', 'padding:10px 14px 12px', 'text-align:center',
                'box-shadow:0 -4px 12px rgba(0,0,0,0.35)', 'line-height:1.55', 'max-height:38vh', 'overflow-y:auto'
            ].join(';');
            var title = document.createElement('strong');
            title.textContent = 'تسجيل دخول اعتماد التقارير (النافذة الثانوية)';
            var titleWrap = document.createElement('div');
            titleWrap.appendChild(title);
            var line = document.createElement('div');
            line.style.marginTop = '6px';
            var idLabel = LOGIN_ID ? LOGIN_ID : '(غير مضبوط — أضف TAQEEM_SECONDARY_LOGIN_ID في .env)';
            var passLabel = PASSWORD ? '••••••••' : '(غير مضبوط — أضف TAQEEM_SECONDARY_PASSWORD في .env)';
            line.textContent = 'الهوية / الإقامة / البريد: ' + idLabel + ' — كلمة المرور: ' + passLabel;
            var hint = document.createElement('div');
            hint.style.marginTop = '6px';
            hint.style.fontSize = '11px';
            hint.style.opacity = '0.92';
            hint.textContent =
                'تم تعبئة الحقول تلقائياً عند توفر القيم في .env؛ أكمل أي خطوة يدوية (مثل التحقق بخطوتين). بعد أول دخول ناجح تُحفظ الجلسة في هذا المتصفح.';
            panel.appendChild(titleWrap);
            panel.appendChild(line);
            panel.appendChild(hint);
            if (document.body) {
                document.body.appendChild(panel);
            }
            return true;
        })();
    `);
}

function attachSecondaryTaqeemAssist(webContents) {
    if (!webContents || webContents.__vtTaqeemAssist) return;
    webContents.__vtTaqeemAssist = true;
    webContents.on('did-finish-load', async () => {
        try {
            if (!webContents || webContents.isDestroyed()) return;
            const url = webContents.getURL() || '';
            if (!shouldOfferTaqeemLoginAssist(url)) return;
            await runTaqeemLoginAssist(webContents);
        } catch (err) {
            console.warn('[MAIN] Taqeem login assist:', err?.message || err);
        }
    });
}

/**
 * Prefer an existing Taqeem web session (persist partition) by opening the app root first.
 * Only hits the explicit OAuth authorize URL if we never land on the IdP or app.
 */
async function loadSecondaryTaqeemSessionStart(win, loginUrl) {
    if (!win || win.isDestroyed()) return;
    wireSecondaryPartitionPersistence();
    attachSecondaryTaqeemAssist(win.webContents);

    await win.loadURL(TAQEEM_APP_HOME_URL);
    let url = await waitForNavigationStable(win.webContents);
    let lower = url.toLowerCase();
    if (lower.startsWith('https://qima.taqeem.gov.sa/')) {
        return;
    }
    if (!lower.includes('sso.taqeem.gov.sa') && !lower.includes('openid-connect')) {
        await win.loadURL(loginUrl);
        url = await waitForNavigationStable(win.webContents);
        lower = url.toLowerCase();
    }
    if (shouldOfferTaqeemLoginAssist(url)) {
        await runTaqeemLoginAssist(win.webContents);
    }
}

const authHandlers = {
    async handleLogin(event, credentials) {
        try {
            console.log('[MAIN] Received login request:', credentials.email);
            const result = await pythonAPI.auth.login(
                credentials.email,
                credentials.password,
                credentials.method,
                credentials.autoOtp || false
            );

            if (result.status === 'OTP_REQUIRED') {
                return { status: 'OTP_REQUIRED', message: 'Please enter OTP' };
            } else if (result.status === 'SUCCESS') {
                return { status: 'SUCCESS', message: 'Login successful' };
            } else {
                return { status: 'ERROR', error: result.error || 'Login failed' };
            }
        } catch (error) {
            console.error('[MAIN] Login error:', error);
            return { status: 'ERROR', error: error.message };
        }
    },

    async handleSubmitOtp(event, otp) {
        try {
            console.log('[MAIN] Received OTP:', otp);
            const result = await pythonAPI.auth.submitOtp(otp);

            if (result.status === 'SUCCESS') {
                return { status: 'SUCCESS', message: 'Authentication complete' };
            } else {
                return { status: 'ERROR', error: result.error || 'OTP verification failed' };
            }
        } catch (error) {
            console.error('[MAIN] OTP error:', error);
            return { status: 'ERROR', error: error.message };
        }
    },

    async getRefreshToken(event, opts = {}) {
        const COOKIE_NAME = opts.name || 'refreshToken';

        try {
            const cookies = await session.defaultSession.cookies.get({ name: COOKIE_NAME });
            if (cookies.length > 0) {
                // Return the first matching cookie's value
                return { status: 'SUCCESS', token: cookies[0].value };
            } else {
                return { status: 'NOT_FOUND' };
            }
        } catch (error) {
            console.error('[MAIN] getRefreshToken error:', error);
            return { status: 'ERROR', error: error.message || String(error) };
        }
    },


    async handleCheckStatus(event) {
        let result;
        try {
            console.log('[MAIN] Received check status request');
            result = await pythonAPI.auth.checkStatus();
            if (!result) {
                return {
                    status: 'ERROR',
                    error: 'Browser status check failed',
                    browserOpen: null
                };
            }

            console.log("Result at handler:", result);

            return {
                status: result.status,
                browserOpen: result?.browserOpen ?? null,
                message: result.message,
                error: result.error
            };

        } catch (error) {
            console.error('[MAIN] Check status error:', error);
            return {
                status: 'ERROR',
                error: error.message,
                browserOpen: result?.browserOpen ?? null,
                message: result?.message || 'Status check failed'
            };
        }
    },

    async handleGetCompanies(event) {
        try {
            console.log('[MAIN] Received get companies request');
            const result = await pythonAPI.auth.getCompanies();
            if (!result) return { status: 'ERROR', error: 'Failed to get companies' };

            console.log("Result at handler:", result);

            return {
                status: result.status,
                data: result.data
            };

        } catch (error) {
            console.error('[MAIN] Get companies error:', error);
            return {
                status: 'ERROR',
                error: error.message
            };
        }
    },

    async handleGetProfile(event) {
        try {
            console.log('[MAIN] Received get profile request');
            const result = await pythonAPI.auth.getProfile();
            if (!result) return { status: 'ERROR', error: 'Failed to get profile' };

            return {
                status: result.status,
                data: result.data || null,
                error: result.error || null
            };

        } catch (error) {
            console.error('[MAIN] Get profile error:', error);
            return {
                status: 'ERROR',
                error: error.message
            };
        }
    },

    async handleNavigateToCompany(event, company) {
        try {
            console.log('[MAIN] Received navigate to company request:', company);
            const result = await pythonAPI.auth.navigateToCompany(company);
            if (!result) return { status: 'ERROR', error: 'Failed to navigate to company' };

            console.log("Result at handler:", result);

            return {
                status: result.status,
                message: result.message,
                url: result.url,
                selectedCompany: result.selectedCompany,
                error: result.error
            };

        } catch (error) {
            console.error('[MAIN] Navigate to company error:', error);
            return {
                status: 'ERROR',
                error: error.message
            };
        }
    },

    async handleRegister(event, userData) {
        try {
            console.log('[MAIN] Received registration request');
            const result = await pythonAPI.auth.register(userData);

            if (result.status === 'SUCCESS') {
                return { status: 'SUCCESS', message: 'Registration successful' };
            } else {
                return { status: 'ERROR', error: result.error || 'Registration failed' };
            }
        } catch (error) {
            console.error('[MAIN] Registration error:', error);
            return { status: 'ERROR', error: error.message };
        }
    },


    async handleSetRefreshToken(event, opts = {}) {
        const {
            baseUrl,
            token,
            name = 'refreshToken',
            path = '/',
            maxAgeDays = 365 * 100,
            sessionOnly = false,
            sameSite = 'lax',
            secure = (process.env.NODE_ENV === 'production'),
            httpOnly = true
        } = opts;

        if (!baseUrl || !token) {
            return { status: 'ERROR', error: 'baseUrl and token are required' };
        }

        try {
            // Ensure url includes protocol
            let cookieUrl = baseUrl;
            if (!/^https?:\/\//i.test(cookieUrl)) cookieUrl = `http://${cookieUrl}`;

            const cookieData = {
                url: cookieUrl,
                name,
                value: token,
                path,
                httpOnly: !!httpOnly,
                secure: !!secure,
                sameSite: (sameSite === 'strict' ? 'strict' : (sameSite === 'no_restriction' ? 'no_restriction' : 'lax'))
            };
            const persistForDays = Number(maxAgeDays);
            const shouldPersist = sessionOnly !== true && Number.isFinite(persistForDays) && persistForDays > 0;
            if (shouldPersist) {
                const nowSeconds = Math.floor(Date.now() / 1000);
                cookieData.expirationDate = nowSeconds + (persistForDays * 24 * 60 * 60);
            }

            await session.defaultSession.cookies.set(cookieData);
            console.log(
                '[MAIN] Set cookie:',
                name,
                'for',
                cookieUrl,
                shouldPersist ? `(persistent ${persistForDays}d)` : '(session-only)'
            );

            return { status: 'SUCCESS' };
        } catch (error) {
            console.error('[MAIN] Failed to set cookie:', error);
            return { status: 'ERROR', error: error.message || String(error) };
        }
    },

    /**
     * Clears cookie (by name) for the given baseUrl.
     * opts: { baseUrl (required), name (optional, default 'refreshToken') }
     */
    async handleClearRefreshToken(event, opts = {}) {
        const { baseUrl, name = 'refreshToken' } = opts;
        if (!baseUrl) {
            return { status: 'ERROR', error: 'baseUrl is required' };
        }
        try {
            let cookieUrl = baseUrl;
            if (!/^https?:\/\//i.test(cookieUrl)) cookieUrl = `http://${cookieUrl}`;

            // Electron cookies.remove expects (url, name)
            await session.defaultSession.cookies.remove(cookieUrl, name);
            console.log('[MAIN] Cleared cookie:', name, 'for', cookieUrl);
            return { status: 'SUCCESS' };
        } catch (error) {
            console.error('[MAIN] Failed to clear cookie:', error);
            return { status: 'ERROR', error: error.message || String(error) };
        }
    },
    async handleOpenTaqeemLogin(event, opts = {}) {
        const loginUrl = opts.url || (
            'https://sso.taqeem.gov.sa/realms/REL_TAQEEM/protocol/openid-connect/auth'
            + '?client_id=cli-qima-valuers'
            + '&redirect_uri=https%3A%2F%2Fqima.taqeem.gov.sa%2Fkeycloak%2Flogin%2Fcallback'
            + '&scope=openid&response_type=code'
        );
        const batchId = opts.batchId;
        const preferChrome = opts.preferChrome !== false;
        const automationOnly = opts.automationOnly || opts.openInAutomation;
        const openIfClosed = opts.onlyIfClosed !== false;
        const navigateIfOpen = !!opts.navigateIfOpen;
        const forceNewAutomation = !!opts.forceNewAutomation;
        const skipStatusCheck = !!opts.skipStatusCheck;
        const waitForLogin = opts.waitForLogin === true;
        const loginTimeoutMs = Number(opts.loginTimeoutMs) || 180000;
        const skipBatchLookup = opts.skipBatchLookup === true;
        const closeAfterAction = opts.closeAfterAction === true;
        let reportIds = normalizeReportIds(opts.reportIds || opts.reports || []);

        try {
            if (automationOnly) {
                const automationResult = await pythonAPI.auth.openLoginPage(loginUrl, {
                    onlyIfClosed: openIfClosed,
                    navigateIfOpen,
                    forceNew: forceNewAutomation,
                    skipStatusCheck
                });

                if (automationResult?.status === 'SUCCESS') {
                    return {
                        status: 'SUCCESS',
                        message: automationResult.message || 'Opened Taqeem login in automation browser',
                        browserOpen: automationResult.browserOpen !== false,
                        alreadyOpen: !!automationResult.alreadyOpen,
                        openedNew: !!automationResult.openedNewBrowser,
                        navigated: !!automationResult.navigated
                    };
                }

                return { status: 'ERROR', error: automationResult?.error || 'Failed to open Taqeem login' };
            }

            if (preferChrome) {
                if (externalLoginInFlight) {
                    return {
                        status: 'SUCCESS',
                        message: 'Taqeem login already opening in external browser'
                    };
                }
                externalLoginInFlight = true;
                try {
                    if (secondaryLoginWindow && !secondaryLoginWindow.isDestroyed()) {
                        secondaryLoginWindow.close();
                        secondaryLoginWindow = null;
                    }
                } catch (err) {
                    // ignore close errors
                }

                const now = Date.now();
                if (now - lastExternalLoginTs < 4000) {
                    externalLoginInFlight = false;
                    return {
                        status: 'SUCCESS',
                        message: 'Taqeem login already opened in external browser'
                    };
                }
                lastExternalLoginTs = now;

                try {
                    await shell.openExternal(loginUrl);

                    setTimeout(() => {
                        externalLoginInFlight = false;
                    }, 4000);

                    return {
                        status: 'SUCCESS',
                        message: 'Opened Taqeem login in external browser'
                    };
                } catch (err) {
                    externalLoginInFlight = false;
                    throw err;
                }
            }
            if (secondaryLoginWindow && !secondaryLoginWindow.isDestroyed()) {
                secondaryLoginWindow.show();
                secondaryLoginWindow.focus();
                await loadSecondaryTaqeemSessionStart(secondaryLoginWindow, loginUrl);
            } else {
                wireSecondaryPartitionPersistence();
                secondaryLoginWindow = new BrowserWindow({
                    width: 1200,
                    height: 800,
                    webPreferences: {
                        partition: SECONDARY_PARTITION,
                        nodeIntegration: false,
                        contextIsolation: true
                    },
                    title: 'Taqeem - Secondary Login'
                });

                secondaryLoginWindow.on('closed', () => {
                    secondaryLoginWindow = null;
                });

                await loadSecondaryTaqeemSessionStart(secondaryLoginWindow, loginUrl);
            }

            if (!reportIds.length && batchId && skipBatchLookup) {
                return {
                    status: 'ERROR',
                    error: `No submitted report IDs were provided for batch ${batchId}`
                };
            }

            if (!reportIds.length && batchId) {
                try {
                    const batchResult = await withTimeout(
                        pythonAPI.auth.getReportsByBatch(batchId),
                        20000,
                        `Loading submitted reports for batch ${batchId}`
                    );
                    if (batchResult?.status === 'SUCCESS' && Array.isArray(batchResult.reports)) {
                        reportIds = normalizeReportIds(batchResult.reports);
                    } else {
                        return { status: 'ERROR', error: batchResult?.error || `No reports found for batch ${batchId}` };
                    }
                } catch (err) {
                    return { status: 'ERROR', error: err.message || String(err) };
                }
            }

            let batchSummary = null;
            if (reportIds.length > 0) {
                if (waitForLogin) {
                    await waitForSecondaryLogin(secondaryLoginWindow, loginTimeoutMs);
                }
                batchSummary = await confirmReportsBatch(secondaryLoginWindow, reportIds);
            }

            if (closeAfterAction && secondaryLoginWindow && !secondaryLoginWindow.isDestroyed()) {
                secondaryLoginWindow.close();
                secondaryLoginWindow = null;
            }

            return {
                status: 'SUCCESS',
                message: closeAfterAction
                    ? 'Processed Taqeem action in a separate browser window and closed it'
                    : 'Opened Taqeem login in a separate browser window',
                batch: batchSummary
            };
        } catch (error) {
            console.error('[MAIN] Failed to open Taqeem login window:', error);
            return { status: 'ERROR', error: error.message || String(error) };
        }
    },

    async handlePublicLogin(event, isAuth) {
        try {
            console.log('[MAIN] Received public login request');
            const result = await pythonAPI.auth.publicLogin(isAuth);
            return result;
        } catch (error) {
            console.error('[MAIN] Login error:', error);
            return { status: 'ERROR', error: error.message };
        }
    }
};

module.exports = authHandlers;
