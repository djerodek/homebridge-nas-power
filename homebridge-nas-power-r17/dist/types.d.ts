import { Logger } from 'homebridge';
type PasswordAuth = {
    password: string;
    privateKeyPath?: never;
    passphrase?: never;
};
type KeyAuth = {
    privateKeyPath: string;
    password?: never;
    passphrase?: string;
};
type AuthConfig = PasswordAuth | KeyAuth;
export type DeviceConfig = AuthConfig & {
    name: string;
    host: string;
    mac?: string;
    port?: number;
    username: string;
    shutdownCommand?: string;
    pollInterval?: number;
    wolVerifyDelay?: number;
    shutdownCooldownDelay?: number;
    wolBroadcastAddress?: string;
    knownHostsPath?: string;
    execTimeout?: number;
    uuidOverride?: string;
    manufacturer?: string;
    model?: string;
    firmwareRevision?: string;
    hardwareRevision?: string;
};
export interface PluginConfig {
    name: string;
    devices?: DeviceConfig[];
}
export interface SshManagerOptions {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKeyPath?: string;
    passphrase?: string;
    knownHostsPath?: string;
    execTimeout?: number;
    log: Logger;
}
export interface WolOptions {
    address?: string;
    port?: number;
}
export {};
//# sourceMappingURL=types.d.ts.map