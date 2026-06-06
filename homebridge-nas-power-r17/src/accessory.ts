import {
  PlatformAccessory,
  Service,
  CharacteristicValue,
} from 'homebridge';
import { NasPowerPlatform } from './platform';
import { SshManager, AmbiguousTimeoutError } from './ssh';
import { sendWol } from './wol';
import { DeviceConfig } from './types';

const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes
const FAILURE_THRESHOLD = 3;
const DEFAULT_SHUTDOWN_COOLDOWN_MS = 30_000;
const WOL_VERIFY_RETRY_MS = 5_000; // Interval between isAlive() checks during WOL verification window

export class NasAccessory {
  private readonly service: Service;
  private readonly ssh: SshManager;

  private readonly name: string;
  private readonly mac?: string;
  private readonly shutdownCommand: string;
  private readonly wolBroadcastAddress: string;
  private readonly wolVerifyDelay: number;
  private readonly pollInterval: number;
  private readonly shutdownCooldownDelay: number;

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private wolVerifyTimer: ReturnType<typeof setTimeout> | null = null;
  // Tracks which generation is currently in the WOL verify window.
  // null means no active verification. Compared against wolVerifyGeneration so
  // stale callbacks from a previous generation cannot clear the active window.
  private activeWolGeneration: number | null = null;
  private shutdownCooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private isPolling = false;
  private currentState: boolean | null = null;
  private consecutiveFailures = 0;
  private destroyed = false;

  // Generation counter for WOL verify callbacks. Incremented on every handleSetInternal
  // call so in-flight isAlive() callbacks from previous WOL cycles detect staleness
  // and skip the characteristic update — prevents rapid ON→OFF→ON from corrupting UI state.
  private wolVerifyGeneration = 0;

  // Convenience logger that prefixes every message with the device name,
  // eliminating repeated `[${this.name}]` boilerplate throughout the class.
  private readonly log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };

  // Self-healing queue: always resolves so the queue never gets permanently stuck.
  // handleSet() returns Promise.resolve() immediately so Homebridge never blocks on SSH.
  // This is a deliberate tradeoff — HomeKit loses direct transactional feedback, but we
  // compensate via optimistic updates and explicit revertState() calls on failure.
  // Automations may see brief false-positive states; this is documented in the README.
  private stateQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly platform: NasPowerPlatform,
    private readonly accessory: PlatformAccessory,
    config: DeviceConfig,
  ) {
    const { log: platformLog, api } = platform;
    const { hap } = api;

    // Local logger — prefixes every message with the device name
    this.log = {
      info: (msg: string) => platformLog.info(`[${config.name}] ${msg}`),
      warn: (msg: string) => platformLog.warn(`[${config.name}] ${msg}`),
      error: (msg: string) => platformLog.error(`[${config.name}] ${msg}`),
    };

    // Validate required fields
    for (const field of ['name', 'host', 'username'] as const) {
      if (!config[field]) {
        throw new Error(`[NasPower] Missing required config field: "${field}"`);
      }
    }
    if (!config.password && !config.privateKeyPath) {
      throw new Error(`[NasPower] Device "${config.name}" requires either "password" or "privateKeyPath".`);
    }

    this.name = config.name;
    if (config.mac !== undefined) this.mac = config.mac;
    this.shutdownCommand = config.shutdownCommand ?? 'sudo shutdown -h now';
    this.wolBroadcastAddress = config.wolBroadcastAddress ?? '255.255.255.255';

    const rawVerifyDelay = Number(config.wolVerifyDelay);
    this.wolVerifyDelay = Number.isFinite(rawVerifyDelay) && rawVerifyDelay >= 1
      ? rawVerifyDelay * 1000
      : 10_000;

    const rawCooldown = Number(config.shutdownCooldownDelay);
    this.shutdownCooldownDelay = Number.isFinite(rawCooldown) && rawCooldown >= 1
      ? rawCooldown * 1000
      : DEFAULT_SHUTDOWN_COOLDOWN_MS;

    const rawInterval = Number(config.pollInterval);
    this.pollInterval = Number.isFinite(rawInterval) && rawInterval >= 5
      ? rawInterval * 1000
      : 30_000;

    if (!this.mac) {
      this.log.warn('No MAC address configured. Power-on (WOL) will not be available.');
    }
    // Runtime check — Homebridge loads config from raw JSON so TypeScript's discriminated
    // union cannot enforce mutual exclusivity at runtime. Cast to loose type to check.
    const looseConfig = config as Record<string, unknown>;
    if (looseConfig['password'] && looseConfig['privateKeyPath']) {
      this.log.warn('Both password and privateKeyPath provided. Private key will be used.');
    }

    this.ssh = new SshManager({
      host: config.host,
      port: config.port ?? 22,
      username: config.username,
      ...(config.password !== undefined && { password: config.password }),
      ...(config.privateKeyPath !== undefined && { privateKeyPath: config.privateKeyPath }),
      ...(config.passphrase !== undefined && { passphrase: config.passphrase }),
      ...(config.knownHostsPath !== undefined && { knownHostsPath: config.knownHostsPath }),
      ...(config.execTimeout !== undefined && { execTimeout: config.execTimeout }),
      log: platformLog,
    });

    // Accessory information
    const infoService = accessory.getService(hap.Service.AccessoryInformation)!;
    infoService
      .setCharacteristic(hap.Characteristic.Manufacturer, config.manufacturer ?? 'NAS')
      .setCharacteristic(hap.Characteristic.Model, config.model ?? 'NAS')
      .setCharacteristic(hap.Characteristic.SerialNumber, this.mac ?? 'unknown');

    if (config.firmwareRevision) {
      infoService.setCharacteristic(hap.Characteristic.FirmwareRevision, config.firmwareRevision);
    }
    if (config.hardwareRevision) {
      infoService.setCharacteristic(hap.Characteristic.HardwareRevision, config.hardwareRevision);
    }

    // Switch service
    this.service = accessory.getService(hap.Service.Switch)
      ?? accessory.addService(hap.Service.Switch);

    this.service.setCharacteristic(hap.Characteristic.Name, this.name);
    this.service.getCharacteristic(hap.Characteristic.On)
      .onGet(this.handleGet.bind(this))
      .onSet(this.handleSet.bind(this));

    this.initialise().catch((err: Error) => {
      this.log.error(`Unexpected initialisation error: ${err.message}`);
    });
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  private async initialise(): Promise<void> {
    try {
      this.currentState = await this.ssh.isAlive();
      this.log.info(`Initial state: ${this.currentState ? 'ON' : 'OFF'}`);
      if (!this.destroyed) {
        this.service.updateCharacteristic(
          this.platform.api.hap.Characteristic.On,
          this.currentState,
        );
      }
    } catch (err) {
      this.log.warn(`Initial state check failed: ${(err as Error).message}. Assuming OFF.`);
      this.currentState = false;
    }
    if (!this.destroyed) {
      this.schedulePoll();
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.activeWolGeneration = null;
    this.isPolling = false; // prevent silent no-op if accessory is re-registered immediately
    if (this.pollTimer !== null) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.wolVerifyTimer !== null) { clearTimeout(this.wolVerifyTimer); this.wolVerifyTimer = null; }
    if (this.shutdownCooldownTimer !== null) { clearTimeout(this.shutdownCooldownTimer); this.shutdownCooldownTimer = null; }
  }

  // ── HomeKit handlers ─────────────────────────────────────────────────────────

  async handleGet(): Promise<CharacteristicValue> {
    // null (pre-init) appears as OFF — unavoidable within HomeKit Switch semantics
    return this.currentState ?? false;
  }

  handleSet(value: CharacteristicValue): Promise<void> {
    // Return immediately so Homebridge never blocks on SSH connection time.
    // Generation is captured inside the queued task (not here) so that the
    // increment happens at actual execution time, not queue-insertion time.
    // This prevents a stale WOL verify from a queued-but-not-yet-run task
    // from overriding state after a newer toggle has already completed.
    this.stateQueue = this.stateQueue.then(() => {
      const generation = ++this.wolVerifyGeneration;
      return this.handleSetInternal(value as boolean, generation);
    }).catch((err: unknown) => {
      // Safety net — errors should be logged inside handleSetInternal before reaching here,
      // but log at this level too so nothing is silently swallowed if a future code path throws early.
      this.log.error(`Unhandled error in state queue: ${(err as Error).message ?? String(err)}`);
    });
    return Promise.resolve();
  }

  private async handleSetInternal(value: boolean, generation: number): Promise<void> {
    if (this.destroyed) return;

    // wolVerifyGeneration gates both WOL verification and shutdown serialisation —
    // the name is WOL-specific but the counter must be incremented on ALL actions
    // (including shutdown) to invalidate any in-flight verify callbacks.
    if (this.wolVerifyTimer !== null) {
      clearTimeout(this.wolVerifyTimer);
      this.wolVerifyTimer = null;
      this.activeWolGeneration = null;
    }
    if (this.shutdownCooldownTimer !== null) {
      clearTimeout(this.shutdownCooldownTimer);
      this.shutdownCooldownTimer = null;
    }

    // Optimistic update — immediate HomeKit feedback; verification corrects if wrong
    this.currentState = value;
    this.service.updateCharacteristic(this.platform.api.hap.Characteristic.On, value);

    if (value) {
      // Reset failure counter here (not in revertState) — only relevant for WOL path.
      // Resetting in revertState would wipe backoff on genuine shutdown failures too.
      this.consecutiveFailures = 0;
      await this.handleWakeOnLan(generation);
    } else {
      await this.handleShutdown();
    }
  }

  // ── WOL ─────────────────────────────────────────────────────────────────────

  private async handleWakeOnLan(generation: number): Promise<void> {
    if (!this.mac) {
      this.log.warn('No MAC address configured for WOL.');
      this.revertState(false, 'No MAC address — reverting to OFF');
      return;
    }

    // Set active flag BEFORE sending packets so any poll timer that fires during
    // the async send sees the window as active and skips — prevents poll/WOL race
    // where the switch flickers OFF mid-send. Using a boolean flag rather than a
    // timer placeholder makes the intent explicit and avoids a stuck-timer edge case.
    this.activeWolGeneration = generation;

    this.log.info(`Sending WOL magic packet to ${this.mac}`);
    let successCount = 0;
    for (let i = 0; i < 3; i++) {
      try {
        await sendWol(this.mac, { address: this.wolBroadcastAddress });
        successCount++;
      } catch (err) {
        this.log.warn(`WOL send attempt ${i + 1} failed: ${(err as Error).message}`);
      }
      if (i < 2) await delay(200);
    }

    if (successCount === 0) {
      this.log.warn('All WOL send attempts failed. Proceeding with verification anyway — first packet may still have reached the NAS.');
    } else {
      this.log.info(`WOL packets sent (${successCount}/3 succeeded). Will verify boot for up to ${this.wolVerifyDelay / 1000}s.`);
    }

    // Use retry count instead of wall clock deadline — Date.now() is not monotonic
    // and can jump backward on NTP slew or clock changes, causing premature expiry.
    const maxRetries = Math.floor(this.wolVerifyDelay / WOL_VERIFY_RETRY_MS);
    let retryCount = 0;

    const scheduleVerify = (): void => {
      if (this.destroyed || this.wolVerifyGeneration !== generation) {
        if (this.activeWolGeneration === generation) { this.activeWolGeneration = null; }
        return;
      }
      if (retryCount >= maxRetries) {
        if (this.activeWolGeneration === generation) { this.activeWolGeneration = null; }
        this.log.warn('WOL verify deadline reached — NAS did not respond. Reporting OFF.');
        this.currentState = false;
        this.service.updateCharacteristic(this.platform.api.hap.Characteristic.On, false);
        this.wolVerifyTimer = null;
        return;
      }

      const timer = setTimeout(async () => {
        this.wolVerifyTimer = null;
        retryCount++;
        if (this.destroyed || this.wolVerifyGeneration !== generation) {
          if (this.activeWolGeneration === generation) { this.activeWolGeneration = null; }
          return;
        }

        try {
          const alive = await this.ssh.isAlive();
          if (this.destroyed || this.wolVerifyGeneration !== generation) {
            if (this.activeWolGeneration === generation) { this.activeWolGeneration = null; }
            return;
          }

          if (alive) {
            if (this.activeWolGeneration === generation) { this.activeWolGeneration = null; }
            this.log.info('Post-WOL check: NAS is UP');
            if (this.currentState !== true) {
              this.currentState = true;
              this.service.updateCharacteristic(this.platform.api.hap.Characteristic.On, true);
            }
          } else {
            this.log.info(`Post-WOL check: NAS still offline. Retrying in ${WOL_VERIFY_RETRY_MS / 1000}s... (${retryCount}/${maxRetries})`);
            scheduleVerify();
          }
        } catch (err) {
          if (this.destroyed || this.wolVerifyGeneration !== generation) {
            if (this.activeWolGeneration === generation) { this.activeWolGeneration = null; }
            return;
          }
          this.log.warn(`Post-WOL verify error: ${(err as Error).message}. Retrying...`);
          scheduleVerify();
        }
      }, Math.max(0, WOL_VERIFY_RETRY_MS)); // Math.max guards against negative delay
      timer.unref(); // allow clean process exit during long verify windows
      this.wolVerifyTimer = timer;
    };

    scheduleVerify();
  }

  // ── Shutdown ─────────────────────────────────────────────────────────────────

  private async handleShutdown(): Promise<void> {
    this.log.info(`Sending shutdown via SSH`);
    try {
      // ambiguousOnTimeout=true: timeout during shutdown likely means NAS powered off
      // mid-execution rather than a genuine failure — treat as expected, not an error.
      await this.ssh.exec(this.shutdownCommand, true);
      if (this.destroyed) return; // Guard against destruction during async gap
      this.log.info(`Shutdown command sent.`);
    } catch (err) {
      if (this.destroyed) return;
      const e = err as NodeJS.ErrnoException;
      const isExpectedDrop =
        e.code === 'ECONNRESET' || e.code === 'EPIPE' ||
        e.code === 'ECONNABORTED' || e.code === 'ENOTCONN' ||
        e.code === 'ECONNREFUSED' || e.code === 'EHOSTUNREACH';
      const isAmbiguousTimeout = err instanceof AmbiguousTimeoutError;

      if (isExpectedDrop || isAmbiguousTimeout) {
        this.log.info(`SSH connection dropped or target unreachable during shutdown (${e.code ?? 'timeout'}). Polling will confirm.`);
      } else {
        this.log.error(`Shutdown failed: ${e.message}`);
        this.revertState(true, 'shutdown command failed');
        return;
      }
    }

    if (this.destroyed) return;

    // Block polling for a configurable grace period to prevent the switch flickering
    // back to ON while the NAS is still in the process of powering down.
    const timer = setTimeout(() => {
      this.shutdownCooldownTimer = null;
    }, this.shutdownCooldownDelay);
    timer.unref();
    this.shutdownCooldownTimer = timer;
  }

  // ── Polling ──────────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (this.isPolling || this.destroyed) return;

    // Skip while WOL verification or shutdown cooldown is active to prevent
    // poll results from flickering the switch during power transitions.
    if (this.activeWolGeneration !== null || this.shutdownCooldownTimer !== null) {
      this.schedulePoll();
      return;
    }

    this.isPolling = true;
    try {
      const alive = await this.ssh.isAlive();
      this.consecutiveFailures = 0;

      // Re-check guards after the async gap — a user may have toggled the switch
      // while we were waiting for the TCP probe. If a transition is now active,
      // discard this result to prevent the poll from flickering the switch.
      if (this.destroyed || this.activeWolGeneration !== null || this.shutdownCooldownTimer !== null) {
        return;
      }

      if (alive !== this.currentState) {
        this.currentState = alive;
        this.log.info(`Power state changed: ${alive ? 'ON' : 'OFF'}`);
        this.service.updateCharacteristic(this.platform.api.hap.Characteristic.On, alive);
      }
    } catch (err) {
      this.consecutiveFailures++;
      this.log.warn(`Poll failed (attempt ${this.consecutiveFailures}): ${(err as Error).message}`);

      // After N consecutive failures, report OFF — handles hard power cuts so the
      // switch doesn't stay stuck ON indefinitely through the backoff window.
      if (this.consecutiveFailures >= FAILURE_THRESHOLD && this.currentState !== false) {
        this.currentState = false;
        this.log.warn(`${FAILURE_THRESHOLD} consecutive poll failures — reporting OFF.`);
        if (!this.destroyed) {
          this.service.updateCharacteristic(this.platform.api.hap.Characteristic.On, false);
        }
      }
    } finally {
      this.isPolling = false;
      if (!this.destroyed) this.schedulePoll();
    }
  }

  private schedulePoll(): void {
    if (this.destroyed) return;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    const interval = this.consecutiveFailures > 0
      ? Math.min(this.pollInterval * Math.pow(2, this.consecutiveFailures), MAX_BACKOFF_MS)
      : this.pollInterval;
    const timer = setTimeout(() => this.poll(), interval);
    timer.unref(); // allow process to exit cleanly if poll is pending
    this.pollTimer = timer;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private revertState(state: boolean, reason?: string): void {
    if (!this.destroyed) {
      this.log.warn(`State reverted to ${state ? 'ON' : 'OFF'}${reason ? ` — ${reason}` : ''}`);
      this.currentState = state;
      this.service.updateCharacteristic(this.platform.api.hap.Characteristic.On, state);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
