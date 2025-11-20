const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron'); // must be executed in main process

class PythonWorkerService {
    constructor() {
        this.worker = null;
        this.stdoutBuffer = '';
        this.pendingCommands = new Map();
        this.commandId = 0;
        this.isWorkerReady = false;

        // If you want a custom startup timeout (ms)
        this.startupTimeout = 10000;
    }


    getPythonExecutable() {
        const projectRoot = path.join(__dirname, '../../../');

        // DEV MODE: prefer venv from project root
        if (!app.isPackaged) {
            if (process.platform === 'win32') {
                const venvPathWin = path.join(projectRoot, '.venv', 'Scripts', 'python.exe');
                if (fs.existsSync(venvPathWin)) return { type: 'python', path: venvPathWin };
                return { type: 'python', path: 'python' };
            } else {
                const venvPathUnix = path.join(projectRoot, '.venv', 'bin', 'python');
                if (fs.existsSync(venvPathUnix)) return { type: 'python', path: venvPathUnix };
                return { type: 'python', path: 'python3' };
            }
        }

        // PACKAGED: look under process.resourcesPath
        try {
            const rp = process.resourcesPath;

            // 1) Look for a single-file executable placed directly in resources/python_exe
            const directExec = path.join(rp, 'python_exe', 'excec_worker');
            if (fs.existsSync(directExec) && fs.statSync(directExec).isFile()) {
                return { type: 'bundle', path: directExec };
            }

            // 2) Look for the executable inside a one-dir folder (in case we copied folder contents)
            const nestedExec = path.join(rp, 'python_exe', 'excec_worker');
            if (fs.existsSync(nestedExec) && fs.statSync(nestedExec).isFile()) {
                return { type: 'bundle', path: nestedExec };
            }

            // 3) In some PyInstaller outputs the executable may have no extension or be named differently
            const candidates = fs.existsSync(path.join(rp, 'python_exe'))
                ? fs.readdirSync(path.join(rp, 'python_exe')).map(f => path.join(rp, 'python_exe', f))
                : [];
            for (const c of candidates) {
                try {
                    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
                        // Heuristic: pick a file that is executable
                        try {
                            fs.accessSync(c, fs.constants.X_OK);
                            return { type: 'bundle', path: c };
                        } catch (e) {
                            // not executable, skip
                        }
                    }
                } catch (e) { }
            }

            // 4) fallback: if we included a full venv under resources/python
            const embeddedPython = path.join(rp, 'python', 'bin', 'python3');
            if (fs.existsSync(embeddedPython)) {
                return { type: 'python', path: embeddedPython };
            }
        } catch (e) {
            console.error('[PY] resource detection error', e && e.message);
        }

        // final fallback to system python
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
        // If worker already running, return it
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
            // In the startWorker method, update this section:
        } else {
            spawnPath = execInfo.path;
            // Run as module instead of direct file execution
            args = ['-m', 'scripts.core.worker'];
            // Set CWD to the project root (where src directory is)
            cwd = path.join(__dirname, '../..'); // This should point to the directory containing 'src'
            console.log(`[PY] Using python module: ${spawnPath} -m scripts.core.worker`);
            console.log(`[PY] Working directory: ${cwd}`);

            // Verify the directory structure exists
            const scriptsPath = path.join(cwd, 'src', 'scripts');
            console.log(`[PY] Scripts path exists: ${fs.existsSync(scriptsPath)}`);
            if (fs.existsSync(scriptsPath)) {
                console.log(`[PY] Scripts directory contents: ${fs.readdirSync(scriptsPath)}`);
            }
        }

        console.log(`[PY] Starting worker: ${spawnPath} ${args.join(' ')}`);
        console.log(`[PY] Spawn path exists: ${fs.existsSync(spawnPath)}`);
        if (cwd) console.log(`[PY] CWD: ${cwd}`);

        // show debug info if path doesn't exist
        if (!fs.existsSync(spawnPath)) {
            console.error('[PY] Worker binary not found at spawnPath:', spawnPath);
            console.error('[PY] process.resourcesPath =', process.resourcesPath);
            try {
                console.error('PY resources listing =', fs.readdirSync(process.resourcesPath));
            } catch (e) {
                console.error('PY resources listing error:', e && e.message);
            }

            const err = new Error(`Worker binary not found at path: ${spawnPath}`);
            // reject any pending commands
            this.pendingCommands.forEach((h) => h.reject(err));
            this.pendingCommands.clear();
            return Promise.reject(err);
        }

        // Normalize if spawnPath is a directory
        const normalized = this._differentiateAndNormalize(spawnPath, cwd);
        spawnPath = normalized.spawnPath;
        cwd = normalized.cwd || cwd;

        // Final check
        if (!fs.existsSync(spawnPath) || !fs.statSync(spawnPath).isFile()) {
            const err = new Error(`Worker binary invalid or not a file: ${spawnPath}`);
            console.error('[PY] ERROR:', err.message);
            this.pendingCommands.forEach((h) => h.reject(err));
            this.pendingCommands.clear();
            return Promise.reject(err);
        }

        // Spawn in a try/catch to catch immediate errors thrown by spawn
        try {
            const workerProcess = spawn(spawnPath, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd });
            this.worker = workerProcess;
            this.stdoutBuffer = '';
            this.isWorkerReady = false;

            // Hook up stdout/stderr before resolving
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
                // Reject all pending commands
                this.pendingCommands.forEach((handler) => {
                    handler.reject(new Error(`Worker exited with code ${code}`));
                });
                this.pendingCommands.clear();
            });

            // Wait for spawn event or timeout
            return await new Promise((resolve, reject) => {
                let resolved = false;

                const onSpawn = () => {
                    if (resolved) return;
                    resolved = true;
                    console.log('[PY] Worker process spawned');
                    this.isWorkerReady = true;
                    resolve(workerProcess);
                };

                // If 'spawn' isn't emitted quickly, also resolve on the 'exit' being not triggered and process still exists
                workerProcess.once('spawn', onSpawn);

                // Safety: timeout
                const t = setTimeout(() => {
                    if (resolved) return;
                    resolved = true;
                    // If still alive, consider it started but warn
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

                // cleanup on error/close
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


    handleWorkerOutput(line) {
        try {
            const response = JSON.parse(line);
            console.log('[PY] Response:', response);

            if (response.commandId !== undefined) {
                const handler = this.pendingCommands.get(response.commandId);
                if (handler) {
                    if (response.status === 'SUCCESS' ||
                        response.status === 'OTP_REQUIRED' ||
                        response.status === 'LOGIN_SUCCESS' ||
                        response.status === 'NOT_LOGGED_IN' ||
                        response.status === 'MACROS_EXIST' ||
                        response.status === 'NOT_FOUND') {
                        handler.resolve(response);
                    } else {
                        handler.reject(new Error(response.error || 'Command failed'));
                    }
                    this.pendingCommands.delete(response.commandId);
                }
            }
        } catch (error) {
            console.error('[PY] Failed to parse worker output:', line, error);
        }
    }


    async sendCommand(command) {
        // Ensure worker is started (awaiting startWorker). startWorker returns or throws.
        try {
            await this.startWorker();
        } catch (err) {
            // Starting worker failed — reject immediately with helpful message
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
            this.pendingCommands.set(commandId, { resolve, reject });

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
            await this.sendCommand({ action: 'close' });
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
