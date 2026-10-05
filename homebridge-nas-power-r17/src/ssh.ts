import { NodeSSH, SSHExecCommandResponse } from 'node-ssh';
import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as crypto from 'crypto';
import * as os from 'os';
import { SshManagerOptions } from './types';

// Prefer the Homebridge storage path env var (set by hb-service and most installs),
// otherwise fall back to ~/.homebridge to avoid surprises when running as root/service.
const HOMEBRIDGE_STORAGE = process.env['HOMEBRIDGE_USER_STORAGE_PATH']
  ?? path.join(os.homedir(), '.homebridge');
const DEFAULT_KNOWN_HOSTS = path.join(HOMEBRIDGE_STORAGE, 'nas-power-known-hosts');

const SSH_TIMEOUT_MS = 5000;        // TCP reachability probe (isAlive)
const SSH_READY_TIMEOUT_MS = 20_000; // SSH handshake + auth for exec. Longer than the probe:
                                     // a busy NAS or sshd reverse-DNS lookup can exceed 5s.
const EXEC_TIMEOUT_MS = 30_000;

/**
 * Normalise a SHA256 fingerprint for comparison. Accepts "SHA256:abc=", "SHA256:abc" or "abc".
 * Node's base64 output keeps "=" padding; ssh-keygen -lf omits it. Both must compare equal.
 */
export function normaliseFingerprint(fp: string): string {
  return fp.trim().replace(/^SHA256:/i, '').replace(/=+$/, '');
}

/** Thrown when an SSH command times out in a context where success is ambiguous. */
export class AmbiguousTimeoutError extends Error {
  constructor() {
    super('SSH command timed out; target may still be shutting down');
    this.name = 'AmbiguousTimeoutError';
  }
}

/** Thrown when an SSH command exits with a non-zero code. */
export class CommandExitError extends Error {
  constructor(
    public readonly command: string,
    public readonly exitCode: number,
    public readonly detail: string,
  ) {
    super(`Command "${command}" exited with code ${exitCode}: ${detail}`);
    this.name = 'CommandExitError';
  }
}

export class SshManager {

  private readonly host: string;
  private readonly port: number;
  private readonly username: string;
  private readonly password?: string;
  private readonly privateKeyPath?: string;
  private privateKeyContents?: string;
  private readonly passphrase?: string;
  private readonly knownHostsPath: string;
  private readonly log: SshManagerOptions['log'];
  private readonly execTimeoutMs: number;
  private knownFingerprint: string | null = null;
  // Fingerprint pinned in config. When set, TOFU and the known-hosts file are bypassed entirely.
  private readonly pinnedFingerprint: string | null;

  constructor(opts: SshManagerOptions) {
    // Strip bracket notation from host if supplied (e.g. [::1] → ::1).
    // Node.js net.Socket and node-ssh both require bare IPv6 addresses.
    this.host = opts.host.replace(/^\[|\]$/g, '');
    this.port = opts.port;
    this.username = opts.username;
    if (opts.password !== undefined) this.password = opts.password;
    if (opts.privateKeyPath !== undefined) this.privateKeyPath = opts.privateKeyPath;
    if (opts.passphrase !== undefined) this.passphrase = opts.passphrase;
    // Treat empty/whitespace path as unset — fall back to default
    this.knownHostsPath = (opts.knownHostsPath && opts.knownHostsPath.trim() !== '')
      ? opts.knownHostsPath
      : DEFAULT_KNOWN_HOSTS;
    this.log = opts.log;
    this.pinnedFingerprint = opts.hostFingerprint && opts.hostFingerprint.trim() !== ''
      ? normaliseFingerprint(opts.hostFingerprint)
      : null;
    const rawExec = Number(opts.execTimeout);
    this.execTimeoutMs = Number.isFinite(rawExec) && rawExec >= 5
      ? rawExec * 1000
      : EXEC_TIMEOUT_MS;

    // Cache private key in memory at construction time — avoids repeated disk reads.
    // If read fails (e.g. temporary mount delay at startup), connect() will retry.
    if (this.privateKeyPath) {
      try {
        this.privateKeyContents = fs.readFileSync(this.privateKeyPath, 'utf8');
      } catch (err) {
        this.log.error(
          `[SSH] Failed to read private key at ${this.privateKeyPath}: ${(err as Error).message}. ` +
          'Will retry on first connection' +
          (this.password ? '; password auth will be used if the retry fails.' : '.'),
        );
      }
    }

    if (this.pinnedFingerprint === null) {
      this.loadKnownFingerprint();
    }
  }

  // ── Known hosts ─────────────────────────────────────────────────────────────

  /**
   * Returns the key used to identify this host in the known hosts file.
   * IPv6 addresses contain colons so we wrap them in brackets to avoid
   * ambiguity when splitting lines: "[::1]:22 SHA256:..."
   */
  private getHostKeyIdentifier(): string {
    // this.host is already bracket-free (stripped in constructor).
    // Wrap in brackets only if it's an IPv6 address (contains colon).
    const normalized = this.host.includes(':') ? `[${this.host}]` : this.host;
    return `${normalized}:${this.port}`;
  }

  private loadKnownFingerprint(): void {
    try {
      if (fs.existsSync(this.knownHostsPath)) {
        const lines = this.readKnownHostsLines();
        // Format: "host:port SHA256:base64fingerprint" — one entry per line.
        // This is a private format specific to this plugin and is NOT interchangeable
        // with a standard OpenSSH ~/.ssh/known_hosts file.
        // IPv6 hosts are stored as [host]:port to avoid colon ambiguity.
        const identifier = this.getHostKeyIdentifier();
        for (const line of lines) {
          // Whitespace-tolerant: handles multiple spaces, tabs and CRLF line endings
          // from hand-edited files.
          const [storedHost, fingerprint] = line.split(/\s+/);
          if (storedHost === identifier && fingerprint) {
            this.knownFingerprint = fingerprint;
            this.log.info(`[SSH] Loaded known fingerprint for ${this.host}`);
            return;
          }
        }
      }
    } catch (err) {
      this.log.warn(`[SSH] Could not read known hosts file: ${(err as Error).message}`);
    }
  }

  private readKnownHostsLines(): string[] {
    return fs.readFileSync(this.knownHostsPath, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean);
  }

  private saveFingerprint(fingerprint: string): void {
    // The whole read-modify-write is synchronous, so two devices in the same Homebridge
    // process cannot interleave. The write goes to a temp file that is then renamed over
    // the target: rename is atomic, so a crash or power loss mid-write cannot truncate the
    // file and wipe every stored fingerprint.
    const storedValue = `SHA256:${fingerprint}`;
    this.knownFingerprint = storedValue;
    const identifier = this.getHostKeyIdentifier();
    const tmpPath = `${this.knownHostsPath}.${process.pid}.tmp`;
    try {
      const dir = path.dirname(this.knownHostsPath);
      fs.mkdirSync(dir, { recursive: true });

      let lines: string[] = [];
      if (fs.existsSync(this.knownHostsPath)) {
        lines = this.readKnownHostsLines();
      }

      lines = lines.filter(l => l.split(/\s+/)[0] !== identifier);
      lines.push(`${identifier} ${storedValue}`);

      // 0o600: owner read/write only. Applied to the temp file, so the renamed file always
      // ends up 0o600 even if an earlier version of the file was more permissive.
      fs.writeFileSync(tmpPath, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.chmodSync(tmpPath, 0o600); // mode is ignored if a stale temp file already existed
      fs.renameSync(tmpPath, this.knownHostsPath);
      this.log.info(`[SSH] Saved fingerprint for ${this.host}`);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* temp file may not exist */ }
      this.log.warn(
        `[SSH] Could not persist fingerprint to disk: ${(err as Error).message}. ` +
        'Verification will work this session but won\'t survive a restart.',
      );
    }
  }

  private fingerprintVerifier(): (hostKey: Buffer) => boolean {
    return (hostKey: Buffer): boolean => {
      const raw = crypto.createHash('sha256').update(hostKey).digest('base64');
      const fingerprint = `SHA256:${raw}`;

      // Pinned fingerprint from config: strict check, no TOFU, nothing persisted.
      if (this.pinnedFingerprint !== null) {
        if (normaliseFingerprint(raw) === this.pinnedFingerprint) return true;
        this.log.error(
          `[SSH] HOST KEY MISMATCH for ${this.host}!\n` +
          `  Configured hostFingerprint: SHA256:${this.pinnedFingerprint}\n` +
          `  Got:                        SHA256:${normaliseFingerprint(raw)}\n` +
          `  If expected (e.g. you reinstalled the OS), verify the new key on the target with:\n` +
          `    ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub\n` +
          `  Then update "hostFingerprint" in your config and restart Homebridge.`,
        );
        return false;
      }

      if (!this.knownFingerprint) {
        this.log.warn(
          `[SSH] First connection to ${this.host} — trusting and storing fingerprint ${fingerprint}`,
        );
        this.saveFingerprint(raw);
        return true;
      }

      if (normaliseFingerprint(this.knownFingerprint) === normaliseFingerprint(raw)) {
        return true;
      }

      this.log.error(
        `[SSH] HOST KEY MISMATCH for ${this.host}!\n` +
        `  Expected: ${this.knownFingerprint}\n` +
        `  Got:      ${fingerprint}\n` +
        `  If expected (e.g. you reinstalled the OS), verify the new key with:\n` +
        `    ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub\n` +
        `  Then delete ${this.knownHostsPath} and restart Homebridge.`,
      );
      return false;
    };
  }

  // ── Core SSH ops ─────────────────────────────────────────────────────────────

  private async connect(): Promise<NodeSSH> {
    const ssh = new NodeSSH();

    const connectOpts: Parameters<NodeSSH['connect']>[0] = {
      host: this.host,
      port: this.port,
      username: this.username,
      readyTimeout: SSH_READY_TIMEOUT_MS,
      hostVerifier: this.fingerprintVerifier(),
    };

    if (this.privateKeyContents) {
      connectOpts.privateKey = this.privateKeyContents;
      if (this.passphrase) {
        connectOpts.passphrase = this.passphrase;
      }
    } else if (this.privateKeyPath) {
      // Key not cached at startup — retry read now (self-healing after transient failures).
      // Uses async I/O to avoid blocking the Node event loop during file system latency.
      try {
        this.privateKeyContents = await fsPromises.readFile(this.privateKeyPath, 'utf8');
        connectOpts.privateKey = this.privateKeyContents;
        if (this.passphrase) {
          connectOpts.passphrase = this.passphrase;
        }
      } catch (err) {
        const reason = (err as Error).message;
        if (!this.password) {
          throw new Error(`Private key at ${this.privateKeyPath} could not be read: ${reason}`);
        }
        // Both fields configured — fall back to password rather than failing outright.
        this.log.warn(
          `[SSH] Private key at ${this.privateKeyPath} could not be read (${reason}). Using password auth.`,
        );
        connectOpts.password = this.password;
      }
    } else if (this.password) {
      connectOpts.password = this.password;
    } else {
      throw new Error('No SSH authentication method configured (password or privateKeyPath required)');
    }

    try {
      await ssh.connect(connectOpts);
      return ssh;
    } catch (err) {
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
  async exec(command: string, ambiguousOnTimeout = false): Promise<SSHExecCommandResponse> {
    const ssh = await this.connect();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const execPromise = ssh.execCommand(command);
      // Attach a no-op catch to execPromise — if the timeout wins the race and
      // ssh.dispose() is called, the pending execCommand promise may reject after
      // disposal. Without this, that rejection could surface as an unhandled warning.
      execPromise.catch(() => { /* swallowed after disposal */ });

      const result = await Promise.race([
        execPromise,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(ambiguousOnTimeout
              ? new AmbiguousTimeoutError()
              : new Error('SSH command execution timed out'),
            );
          }, this.execTimeoutMs);
          timeoutId.unref();
        }),
      ]);

      if (result.code !== 0 && result.code !== null) {
        const detail = [result.stderr, result.stdout].filter(Boolean).join(' | ') || '(no output)';
        throw new CommandExitError(command, result.code, detail);
      }
      return result;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      ssh.dispose();
    }
  }

  isAlive(): Promise<boolean> {
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

      socket.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        socket.removeAllListeners();
        socket.destroy();
        if (
          err.code === 'ECONNREFUSED' ||
          err.code === 'ETIMEDOUT' ||
          err.code === 'EHOSTUNREACH' ||
          err.code === 'EHOSTDOWN' || // ARP failure — host known to be down, treat as offline not error
          err.code === 'ENETUNREACH'  // local interface drop — resolving false avoids triggering backoff
                                     // when the RPi's own network is momentarily unavailable
        ) {
          resolve(false);
        } else {
          // True network anomaly (e.g. DNS failure, EAI_AGAIN) — trigger backoff
          reject(err);
        }
      });
    });
  }
}
