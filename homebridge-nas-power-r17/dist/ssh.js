"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SshManager = exports.AmbiguousTimeoutError = void 0;
const node_ssh_1 = require("node-ssh");
const fs = __importStar(require("fs"));
const fs_1 = require("fs");
const path = __importStar(require("path"));
const net = __importStar(require("net"));
const crypto = __importStar(require("crypto"));
const os = __importStar(require("os"));
// Prefer the Homebridge storage path env var (set by hb-service and most installs),
// otherwise fall back to ~/.homebridge to avoid surprises when running as root/service.
const HOMEBRIDGE_STORAGE = process.env['HOMEBRIDGE_USER_STORAGE_PATH']
    ?? path.join(os.homedir(), '.homebridge');
const DEFAULT_KNOWN_HOSTS = path.join(HOMEBRIDGE_STORAGE, 'nas-power-known-hosts');
const SSH_TIMEOUT_MS = 5000;
const EXEC_TIMEOUT_MS = 30000;
/** Thrown when an SSH command times out in a context where success is ambiguous. */
class AmbiguousTimeoutError extends Error {
    constructor() {
        super('SSH command timed out; NAS may still be shutting down');
        this.name = 'AmbiguousTimeoutError';
    }
}
exports.AmbiguousTimeoutError = AmbiguousTimeoutError;
class SshManager {
    constructor(opts) {
        this.knownFingerprint = null;
        this.host = opts.host;
        this.port = opts.port;
        this.username = opts.username;
        if (opts.password !== undefined)
            this.password = opts.password;
        if (opts.privateKeyPath !== undefined)
            this.privateKeyPath = opts.privateKeyPath;
        if (opts.passphrase !== undefined)
            this.passphrase = opts.passphrase;
        // Treat empty/whitespace path as unset — fall back to default
        this.knownHostsPath = (opts.knownHostsPath && opts.knownHostsPath.trim() !== '')
            ? opts.knownHostsPath
            : DEFAULT_KNOWN_HOSTS;
        this.log = opts.log;
        const rawExec = Number(opts.execTimeout);
        this.execTimeoutMs = Number.isFinite(rawExec) && rawExec >= 5
            ? rawExec * 1000
            : EXEC_TIMEOUT_MS;
        // Cache private key in memory at construction time — avoids repeated disk reads.
        // If read fails (e.g. temporary mount delay at startup), connect() will retry.
        if (this.privateKeyPath) {
            try {
                this.privateKeyContents = fs.readFileSync(this.privateKeyPath, 'utf8');
            }
            catch (err) {
                this.log.error(`[SSH] Failed to read private key at ${this.privateKeyPath}: ${err.message}. ` +
                    'Will retry on first connection.');
            }
        }
        this.loadKnownFingerprint();
    }
    // ── Known hosts ─────────────────────────────────────────────────────────────
    loadKnownFingerprint() {
        try {
            if (fs.existsSync(this.knownHostsPath)) {
                const data = fs.readFileSync(this.knownHostsPath, 'utf8').trim();
                const lines = data.split('\n').filter(Boolean);
                // Format: "host:port SHA256:base64fingerprint" — one entry per line.
                // This is a private format specific to this plugin and is NOT interchangeable
                // with a standard OpenSSH ~/.ssh/known_hosts file.
                for (const line of lines) {
                    const [storedHost, fingerprint] = line.split(' ');
                    if (storedHost === `${this.host}:${this.port}`) {
                        this.knownFingerprint = fingerprint ?? null;
                        this.log.info(`[SSH] Loaded known fingerprint for ${this.host}`);
                        return;
                    }
                }
            }
        }
        catch (err) {
            this.log.warn(`[SSH] Could not read known hosts file: ${err.message}`);
        }
    }
    saveFingerprint(fingerprint) {
        // Synchronous write: fingerprint saving is a rare, one-shot event per device lifetime.
        // Not truly atomic (four syscalls: mkdirSync, existsSync, readFileSync, writeFileSync),
        // but benign at Homebridge plugin scale — at worst one entry is lost and re-saved on
        // the next connection.
        const storedValue = `SHA256:${fingerprint}`;
        this.knownFingerprint = storedValue;
        try {
            const dir = path.dirname(this.knownHostsPath);
            fs.mkdirSync(dir, { recursive: true });
            let lines = [];
            if (fs.existsSync(this.knownHostsPath)) {
                lines = fs.readFileSync(this.knownHostsPath, 'utf8').trim().split('\n').filter(Boolean);
            }
            lines = lines.filter(l => !l.startsWith(`${this.host}:${this.port} `));
            lines.push(`${this.host}:${this.port} ${storedValue}`);
            // 0o600: owner read/write only — good hygiene for a trust store file
            fs.writeFileSync(this.knownHostsPath, lines.join('\n') + '\n', {
                encoding: 'utf8',
                mode: 0o600,
            });
            this.log.info(`[SSH] Saved fingerprint for ${this.host}`);
        }
        catch (err) {
            this.log.warn(`[SSH] Could not persist fingerprint to disk: ${err.message}. ` +
                'Verification will work this session but won\'t survive a restart.');
        }
    }
    fingerprintVerifier() {
        return (hostKey) => {
            const raw = crypto.createHash('sha256').update(hostKey).digest('base64');
            const fingerprint = `SHA256:${raw}`;
            if (!this.knownFingerprint) {
                this.log.warn(`[SSH] First connection to ${this.host} — trusting and storing fingerprint ${fingerprint}`);
                this.saveFingerprint(raw);
                return true;
            }
            if (this.knownFingerprint === fingerprint) {
                return true;
            }
            this.log.error(`[SSH] HOST KEY MISMATCH for ${this.host}!\n` +
                `  Expected: ${this.knownFingerprint}\n` +
                `  Got:      ${fingerprint}\n` +
                `  If expected (e.g. you reinstalled the OS), verify the new key with:\n` +
                `    ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub\n` +
                `  Then delete ${this.knownHostsPath} and restart Homebridge.`);
            return false;
        };
    }
    // ── Core SSH ops ─────────────────────────────────────────────────────────────
    async connect() {
        const ssh = new node_ssh_1.NodeSSH();
        const connectOpts = {
            host: this.host,
            port: this.port,
            username: this.username,
            readyTimeout: SSH_TIMEOUT_MS,
            hostVerifier: this.fingerprintVerifier(),
        };
        if (this.privateKeyContents) {
            connectOpts.privateKey = this.privateKeyContents;
            if (this.passphrase) {
                connectOpts.passphrase = this.passphrase;
            }
        }
        else if (this.privateKeyPath) {
            // Key not cached at startup — retry read now (self-healing after transient failures).
            // Uses async I/O to avoid blocking the Node event loop during file system latency.
            try {
                this.privateKeyContents = await fs_1.promises.readFile(this.privateKeyPath, 'utf8');
                connectOpts.privateKey = this.privateKeyContents;
                if (this.passphrase) {
                    connectOpts.passphrase = this.passphrase;
                }
            }
            catch (err) {
                throw new Error(`Private key at ${this.privateKeyPath} could not be read: ${err.message}`);
            }
        }
        else if (this.password) {
            connectOpts.password = this.password;
        }
        else {
            throw new Error('No SSH authentication method configured (password or privateKeyPath required)');
        }
        try {
            await ssh.connect(connectOpts);
            return ssh;
        }
        catch (err) {
            ssh.dispose();
            throw err;
        }
    }
    /**
     * Execute a command over SSH.
     * @param command          - Shell command to run on the remote host
     * @param ambiguousOnTimeout - If true, timeout is treated as uncertain rather than failure.
     *                            Use for shutdown commands where the NAS may power off mid-execution,
     *                            causing the timeout to fire even though shutdown succeeded.
     */
    async exec(command, ambiguousOnTimeout = false) {
        const ssh = await this.connect();
        let timeoutId;
        try {
            const execPromise = ssh.execCommand(command);
            // Attach a no-op catch to execPromise — if the timeout wins the race and
            // ssh.dispose() is called, the pending execCommand promise may reject after
            // disposal. Without this, that rejection could surface as an unhandled warning.
            execPromise.catch(() => { });
            const result = await Promise.race([
                execPromise,
                new Promise((_, reject) => {
                    timeoutId = setTimeout(() => {
                        reject(ambiguousOnTimeout
                            ? new AmbiguousTimeoutError()
                            : new Error('SSH command execution timed out'));
                    }, this.execTimeoutMs);
                }),
            ]);
            if (result.code !== 0 && result.code !== null) {
                throw new Error(`Command exited with code ${result.code}: ${result.stderr || '(no stderr)'}`);
            }
            return result;
        }
        finally {
            if (timeoutId !== undefined)
                clearTimeout(timeoutId);
            ssh.dispose();
        }
    }
    isAlive() {
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            const timeout = setTimeout(() => {
                socket.removeAllListeners();
                socket.destroy();
                resolve(false);
            }, SSH_TIMEOUT_MS);
            timeout.unref(); // allow process to exit cleanly if this probe is still pending
            socket.connect(this.port, this.host, () => {
                clearTimeout(timeout);
                socket.removeAllListeners();
                socket.destroy();
                resolve(true);
            });
            // unref() allows the Node process to exit even if this socket is still pending —
            // prevents a polling probe from blocking Homebridge shutdown for up to SSH_TIMEOUT_MS.
            socket.unref();
            socket.on('error', (err) => {
                clearTimeout(timeout);
                socket.removeAllListeners();
                socket.destroy();
                if (err.code === 'ECONNREFUSED' ||
                    err.code === 'ETIMEDOUT' ||
                    err.code === 'EHOSTUNREACH' ||
                    err.code === 'EHOSTDOWN' ||
                    err.code === 'ENETUNREACH') {
                    // Host unreachable or port closed — treat as offline, not a network error.
                    // ENETUNREACH included: local network interface drop should not trigger backoff.
                    resolve(false);
                }
                else {
                    // True network anomaly (e.g. DNS failure, EAI_AGAIN) — trigger backoff
                    reject(err);
                }
            });
        });
    }
}
exports.SshManager = SshManager;
//# sourceMappingURL=ssh.js.map