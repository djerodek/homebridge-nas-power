// Auth fields are all optional at the type level. Homebridge loads config from raw JSON,
// and the schema, README and runtime all allow password and privateKeyPath together
// (private key takes priority, password is the fallback). "At least one" is enforced
// at runtime in platform.ts and accessory.ts.
export type DeviceConfig = {
  name: string;
  host: string;
  mac?: string;
  port?: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  shutdownCommand?: string;
  pollInterval?: number;
  wolVerifyDelay?: number;
  shutdownCooldownDelay?: number;
  wolBroadcastAddress?: string;
  knownHostsPath?: string;
  hostFingerprint?: string;
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

/** Minimal logger interface used by the accessory and SSH layers. */
export interface DeviceLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface SshManagerOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  knownHostsPath?: string;
  hostFingerprint?: string;
  execTimeout?: number;
  log: DeviceLogger;
}

export interface WolOptions {
  address?: string;
  port?: number;
}
