const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

class PythonWorkerService {
    constructor() {
        this.worker = null;
        this.stdoutBuffer = '';
        this.pendingCommands = new Map();
        this.commandId = 0;
        this.isWorkerReady = false;
        this.startupTimeout = 10000;
        this.progressCallbacks = new Map(); // Store progress callbacks by reportId
    }

    isResolvedStatus(status) {
        return [
            'SUCCESS',
            'STOPPED',
            'PAUSED',
            'RESUMED',
            'PARTIAL_SUCCESS',
            'OTP_REQUIRED',
            'LOGIN_SUCCESS',
            'NOT_LOGGED_IN',
            'MACROS_EXIST',
            'NOT_FOUND',
            'CHECK',
            'CANCELLED',
        ].includes(String(status || '').toUpperCase());
    }

    // Register a progress callback for a specific report
    registerProgressCallback(reportId, callback) {
        this.progressCallbacks.set(reportId, callback);
    }

    // Unregister a progress callback
    unregisterProgressCallback(reportId) {
        this.progressCallbacks.delete(reportId);
    }

    getPythonExecutable() {
        const projectRoot = path.join(__dirname, '../../../');

        if (!app.isPackaged) {
            if (process.platform === 'win32') {
                const venvPathWin = path.join(projectRoot, '.venv', 'Scripts', 'python.exe');
                if (fs.existsSync(venvPathWin)) return { type: 'python', path: venvPathWin };

                // Fallback to "venv" to support environments created with the default name
                const legacyVenvPathWin = path.join(projectRoot, 'venv', 'Scripts', 'python.exe');
                if (fs.existsSync(legacyVenvPathWin)) return { type: 'python', path: legacyVenvPathWin };

                return { type: 'python', path: 'python' };
            } else {
                const venvPathUnix = path.join(projectRoot, '.venv', 'bin', 'python');
                if (fs.existsSync(venvPathUnix)) return { type: 'python', path: venvPathUnix };

                const legacyVenvPathUnix = path.join(projectRoot, 'venv', 'bin', 'python');
                if (fs.existsSync(legacyVenvPathUnix)) return { type: 'python', path: legacyVenvPathUnix };

                return { type: 'python', path: 'python3' };
            }
        }

        try {
            const rp = process.resourcesPath;
            const directExec = path.join(rp, 'python_exe', 'excec_worker');
            if (fs.existsSync(directExec) && fs.statSync(directExec).isFile()) {
                return { type: 'bundle', path: directExec };
            }

            const nestedExec = path.join(rp, 'python_exe', 'excec_worker');
            if (fs.existsSync(nestedExec) && fs.statSync(nestedExec).isFile()) {
                return { type: 'bundle', path: nestedExec };
            }

            const candidates = fs.existsSync(path.join(rp, 'python_exe'))
                ? fs.readdirSync(path.join(rp, 'python_exe')).map(f => path.join(rp, 'python_exe', f))
                : [];
            for (const c of candidates) {
                try {
                    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
                        try {
                            fs.accessSync(c, fs.constants.X_OK);
                            return { type: 'bundle', path: c };
                        } catch (e) { }
                    }
                } catch (e) { }
            }

            const embeddedPython = path.join(rp, 'python', 'bin', 'python3');
            if (fs.existsSync(embeddedPython)) {
                return { type: 'python', path: embeddedPython };
            }
        } catch (e) {
            console.error('[PY] resource detection error', e && e.message);
        }

        return { type: 'python', path: 'python3' };
    }

    _normalizeSpawnPath(spawnPath, cwd) {
        try {
            if (!fs.existsSync(spawnPath)) return { spawnPath, cwd };

            const st = fs.statSync(spawnPath);
            if (st.isDirectory()) {
                console.log('[PY DEBUG] spawnPath is a directory; scanning for executable...');
                const files = fs.readdirSync(spawnPath).filter(Boolean);
                console.log('[PY DEBUG] directory contents:', files);

                const base = path.basename(spawnPath);
                let candidate = files.find(f => f === base);

                if (!candidate) {
                    candidate = files.find(f => {
                        const ext = path.extname(f).toLowerCase();
                        return ext !== '.py' && ext !== '.txt';
                    });
                }

                if (!candidate) {
                    candidate = files.find(f => {
                        try {
                            const s = fs.statSync(path.join(spawnPath, f));
                            return s.isFile();
                        } catch (e) {
                            return false;
                        }
                    });
                }

                if (candidate) {
                    const candidatePath = path.join(spawnPath, candidate);
                    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
                        spawnPath = candidatePath;
                        cwd = path.dirname(candidatePath);
                        console.log('[PY DEBUG] _normalizeSpawnPath -> candidate chosen:', spawnPath);
                    }
                }
            }
        } catch (err) {
            console.error('[PY DEBUG] error normalizing spawnPath:', err && err.message);
        }
        return { spawnPath, cwd };
    }

    async startWorker() {
        if (this.worker && !this.worker.killed) {
            console.log('[PY] Worker already running');
            return this.worker;
        }

        const execInfo = this.getPythonExecutable();
        let spawnPath;
        let args = [];
        let cwd = null;

        if (execInfo.type === 'bundle') {
            spawnPath = execInfo.path;
            cwd = path.dirname(spawnPath);
            console.log(`[PY] Using bundled worker: ${spawnPath}`);
        } else {
            spawnPath = execInfo.path;
            args = ['-m', 'scripts.core.worker'];
            cwd = path.join(__dirname, '../..');
            console.log(`[PY] Using python module: ${spawnPath} -m scripts.core.worker`);
            console.log(`[PY] Working directory: ${cwd}`);

            const scriptsPath = path.join(cwd, 'src', 'scripts');
            console.log(`[PY] Scripts path exists: ${fs.existsSync(scriptsPath)}`);
            if (fs.existsSync(scriptsPath)) {
                console.log(`[PY] Scripts directory contents: ${fs.readdirSync(scriptsPath)}`);
            }
        }

        console.log(`[PY] Starting worker: ${spawnPath} ${args.join(' ')}`);
        console.log(`[PY] Spawn path exists: ${fs.existsSync(spawnPath)}`);
        if (cwd) console.log(`[PY] CWD: ${cwd}`);

        if (!fs.existsSync(spawnPath)) {
            console.error('[PY] Worker binary not found at spawnPath:', spawnPath);
            console.error('[PY] process.resourcesPath =', process.resourcesPath);
            try {
                console.error('PY resources listing =', fs.readdirSync(process.resourcesPath));
            } catch (e) {
                console.error('PY resources listing error:', e && e.message);
            }

            const err = new Error(`Worker binary not found at path: ${spawnPath}`);
            this.pendingCommands.forEach((h) => h.reject(err));
            this.pendingCommands.clear();
            return Promise.reject(err);
        }

        const normalized = this._differentiateAndNormalize(spawnPath, cwd);
        spawnPath = normalized.spawnPath;
        cwd = normalized.cwd || cwd;

        if (!fs.existsSync(spawnPath) || !fs.statSync(spawnPath).isFile()) {
            const err = new Error(`Worker binary invalid or not a file: ${spawnPath}`);
            console.error('[PY] ERROR:', err.message);
            this.pendingCommands.forEach((h) => h.reject(err));
            this.pendingCommands.clear();
            return Promise.reject(err);
        }

        try {
            const workerProcess = spawn(spawnPath, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd });
            this.worker = workerProcess;
            this.stdoutBuffer = '';
            this.isWorkerReady = false;

            workerProcess.stdout.on('data', (data) => {
                this.stdoutBuffer += data.toString();
                const lines = this.stdoutBuffer.split(/\r?\n/);
                this.stdoutBuffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.trim()) continue;
                    this.handleWorkerOutput(line);
                }
            });

            workerProcess.stderr.on('data', (data) => {
                console.log(`[PY STDERR] ${data.toString().trim()}`);
            });

            workerProcess.on('error', (error) => {
                console.error('[PY] Worker process error event:', error && error.message);
            });

            workerProcess.on('close', (code, signal) => {
                console.log(`[PY] Worker exited (code=${code}, signal=${signal})`);
                this.isWorkerReady = false;
                this.worker = null;
                this.pendingCommands.forEach((handler) => {
                    handler.reject(new Error(`Worker exited with code ${code}`));
                });
                this.pendingCommands.clear();
            });

            return await new Promise((resolve, reject) => {
                let resolved = false;

                const onSpawn = () => {
                    if (resolved) return;
                    resolved = true;
                    console.log('[PY] Worker process spawned');
                    this.isWorkerReady = true;
                    resolve(workerProcess);
                };

                workerProcess.once('spawn', onSpawn);

                const t = setTimeout(() => {
                    if (resolved) return;
                    resolved = true;
                    if (!workerProcess.killed) {
                        console.warn('[PY] Worker did not emit spawn quickly, but process exists. Marking as ready.');
                        this.isWorkerReady = true;
                        resolve(workerProcess);
                    } else {
                        const err = new Error('Worker failed to spawn in time');
                        console.error('[PY] ' + err.message);
                        reject(err);
                    }
                }, this.startupTimeout);

                workerProcess.once('error', (err) => {
                    if (resolved) return;
                    clearTimeout(t);
                    resolved = true;
                    console.error('[PY] spawn error event:', err && err.message);
                    reject(err);
                });

                workerProcess.once('close', (code, sig) => {
                    if (resolved) return;
                    clearTimeout(t);
                    resolved = true;
                    const err = new Error(`Worker closed before ready (code=${code}, signal=${sig})`);
                    console.error('[PY] ' + err.message);
                    reject(err);
                });
            });
        } catch (err) {
            console.error('[PY] spawn() threw synchronous error:', err && err.message);
            this.worker = null;
            this.isWorkerReady = false;
            this.pendingCommands.forEach((h) => h.reject(err));
            this.pendingCommands.clear();
            return Promise.reject(err);
        }
    }

    _differentiateAndNormalize(spawnPath, cwd) {
        return this._normalizeSpawnPath(spawnPath, cwd);
    }

    _looksLikeJsonPayload(line) {
        const trimmed = String(line || '').trim();
        if (!trimmed) return false;
        if (trimmed.startsWith('{')) return true;
        if (!trimmed.startsWith('[')) return false;

        // Avoid false positives like "[TAB-0] ..." that are plain logs, not JSON.
        const afterBracket = trimmed.slice(1).trimStart();
        if (!afterBracket) return false;
        const first = afterBracket[0];
        if (first === '{' || first === '[' || first === '"' || first === '-') return true;
        if (first >= '0' && first <= '9') return true;
        return (
            afterBracket.startsWith('true') ||
            afterBracket.startsWith('false') ||
            afterBracket.startsWith('null')
        );
    }

    handleWorkerOutput(line) {
        // Skip empty lines
        if (!line || !line.trim()) return;

        const trimmedLine = line.trim();
        if (!this._looksLikeJsonPayload(trimmedLine)) {
            if (process.env.PY_VERBOSE_LOGS === '1') {
                console.log('[PY] Log output:', trimmedLine);
            }
            return;
        }

        try {
            const response = JSON.parse(trimmedLine);
            console.log('[PY] Response:', response);

            // Handle progress updates
            if (response.type === 'progress') {
                let reportId = response.reportId || response.processId;

                // Extract reportId from processId for delete-report processes
                if (response.processId && response.processId.startsWith('delete-report-')) {
                    reportId = response.processId.replace('delete-report-', '');
                }

                // Extract reportId from processId for delete-incomplete-assets processes
                if (response.processId && response.processId.startsWith('delete-incomplete-assets-')) {
                    reportId = response.processId.replace('delete-incomplete-assets-', '');
                }

                const callback = this.progressCallbacks.get(reportId);
                if (callback) {
                    // Transform the progress data to match frontend expectations
                    const progressData = {
                        reportId,
                        current: response.completed || 0,
                        total: response.total || 1,
                        percentage: response.percentage || 0,
                        message: response.message || `Processing: ${response.completed || 0}/${response.total || 1}`,
                        status: response.status,
                        createdReportId: response.createdReportId,
                        paused: response.paused || false,
                        stopped: response.stopped || false,
                        processType: response.processType,
                        timestamp: response.timestamp
                    };
                    console.log('[PY] Sending progress update:', progressData);
                    callback(progressData);
                } else {
                    console.log('[PY] No callback found for reportId:', reportId, 'available callbacks:', Array.from(this.progressCallbacks.keys()));
                }
                return; // Don't process as command response
            }

            // Handle command responses
            if (response.commandId !== undefined) {
                const handler = this.pendingCommands.get(response.commandId);
                if (handler) {
                    const allowFailure = handler.allowFailure === true;
                    if (this.isResolvedStatus(response.status) || allowFailure) {
                        handler.resolve(response);
                    } else {
                        handler.reject(new Error(response.error || 'Command failed'));
                    }
                    this.pendingCommands.delete(response.commandId);
                }
            }
        } catch (error) {
            if (process.env.PY_VERBOSE_LOGS === '1') {
                console.log('[PY] Failed to parse worker output:', trimmedLine, 'Error:', error.message);
            }
        }
    }

    async sendCommand(command, options = {}) {
        try {
            await this.startWorker();
        } catch (err) {
            const e = new Error(`Failed to start Python worker: ${err.message}`);
            console.error('[PY] ' + e.message);
            return Promise.reject(e);
        }

        if (!this.worker || !this.isWorkerReady) {
            const e = new Error('Worker not ready after startWorker()');
            console.error('[PY] ' + e.message);
            return Promise.reject(e);
        }

        const commandId = this.commandId++;
        const commandWithId = { ...command, commandId };

        return new Promise((resolve, reject) => {
            this.pendingCommands.set(commandId, {
                resolve,
                reject,
                allowFailure: options.allowFailure === true
            });

            try {
                this.worker.stdin.write(JSON.stringify(commandWithId) + '\n');
                console.log(`[PY] Sent command: ${command.action} (id: ${commandId})`);
            } catch (error) {
                this.pendingCommands.delete(commandId);
                console.error('[PY] Failed to send command to worker:', error && error.message);
                reject(new Error(`Failed to send command to worker: ${error.message}`));
            }
        });
    }

    async closeWorker() {
        if (!this.worker) return;

        try {
            await this.sendCommand({ action: 'close' }, { allowFailure: true });
        } catch (error) {
            console.log('[PY] Close command failed, forcing shutdown:', error.message);
        } finally {
            if (this.worker) {
                this.worker.kill('SIGTERM');
                this.worker = null;
                this.isWorkerReady = false;
            }
        }
    }

    isReady() {
        return this.isWorkerReady && this.worker && !this.worker.killed;
    }
}

module.exports = PythonWorkerService;
