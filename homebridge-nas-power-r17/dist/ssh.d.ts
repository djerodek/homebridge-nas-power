import { SSHExecCommandResponse } from 'node-ssh';
import { SshManagerOptions } from './types';
/** Thrown when an SSH command times out in a context where success is ambiguous. */
export declare class AmbiguousTimeoutError extends Error {
    constructor();
}
/** Thrown when an SSH command exits with a non-zero code. */
export declare class CommandExitError extends Error {
    readonly command: string;
    readonly exitCode: number;
    readonly detail: string;
    constructor(command: string, exitCode: number, detail: string);
}
export declare class SshManager {
    private readonly host;
    private readonly port;
    private readonly username;
    private readonly password?;
    private readonly privateKeyPath?;
    private privateKeyContents?;
    private readonly passphrase?;
    private readonly knownHostsPath;
    private readonly log;
    private readonly execTimeoutMs;
    private knownFingerprint;
    constructor(opts: SshManagerOptions);
    /**
     * Returns the key used to identify this host in the known hosts file.
     * IPv6 addresses contain colons so we wrap them in brackets to avoid
     * ambiguity when splitting lines: "[::1]:22 SHA256:..."
     */
    private getHostKeyIdentifier;
    private loadKnownFingerprint;
    private saveFingerprint;
    private fingerprintVerifier;
    private connect;
    /**
     * Execute a command over SSH.
     * @param command          - Shell command to run on the remote host
     * @param ambiguousOnTimeout - If true, timeout is treated as uncertain rather than failure.
     *                            Use for shutdown commands where the NAS may power off mid-execution,
     *                            causing the timeout to fire even though shutdown succeeded.
     */
    exec(command: string, ambiguousOnTimeout?: boolean): Promise<SSHExecCommandResponse>;
    isAlive(): Promise<boolean>;
}
//# sourceMappingURL=ssh.d.ts.map