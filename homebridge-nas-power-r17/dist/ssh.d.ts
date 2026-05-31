import { SSHExecCommandResponse } from 'node-ssh';
import { SshManagerOptions } from './types';
/** Thrown when an SSH command times out in a context where success is ambiguous. */
export declare class AmbiguousTimeoutError extends Error {
    constructor();
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