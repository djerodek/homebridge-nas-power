import {
  PlatformAccessory,
  Service,
  CharacteristicValue,
  Logger,
} from 'homebridge';
import { NasPowerPlatform } from './platform';
import { SshManager, AmbiguousTimeoutError, CommandExitError } from './ssh';
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
    this.wolVerifyDelay = Number.isFinite(rawVerifyDelay) && rawVerifyDelay >= 5
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

    const rawPort = config.port ?? 22;
    if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
      throw new Error(`[NasPower] Device "${config.name}" has invalid port: ${rawPort}. Must be 1-65535.`);
    }

    this.ssh = new SshManager({
      host: config.host,
      port: rawPort,
      username: config.username,
      ...(config.password !== undefined && { password: config.password }),
      ...(config.privateKeyPath !== undefined && { privateKeyPath: config.privateKeyPath }),
      ...(config.passphrase !== undefined && { passphrase: config.passphrase }),
      ...(config.knownHostsPath !== undefined && { knownHostsPath: config.knownHostsPath }),
      ...(config.execTimeout !== undefined && { execTimeout: config.execTimeout }),
      // Pass the device-prefixed logger so SSH log entries are attributed to the
      // correct device in multi-device setups rather than the global platform log.
      log: this.log as unknown as Logger,
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
    this.isPolling = false;
    // Resetting the reference allows the chain to be GC'd after pending tasks complete.
    // Note: tasks already chained onto the old queue before destroy() was called will
    // still execute, but each checks this.destroyed at entry and exits as a no-op.
    this.stateQueue = Promise.resolve();
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
      this.log.error(`Unhandled error in state queue: ${err instanceof Error ? err.message : String(err)}`);
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
      // Mark this generation as the active WOL window — isWolWindowActive() will
      // automatically return false when wolVerifyGeneration increments on next action,
      // eliminating the need for manual cleanup in each callback.
      this.activeWolGeneration = generation;
      await this.handleWakeOnLan(generation);
    } else {
      // Ensure no WOL window is considered active during shutdown
      this.activeWolGeneration = null;
      await this.handleShutdown(generation);
    }
  }

  // ── WOL ─────────────────────────────────────────────────────────────────────

  private async handleWakeOnLan(generation: number): Promise<void> {
    if (!this.mac) {
      this.log.warn('No MAC address configured for WOL.');
      // Clear the WOL window set by handleSetInternal — without this, polling
      // would be suppressed until the user next toggles the switch.
      this.activeWolGeneration = null;
      this.revertState(false, 'No MAC address — reverting to OFF');
      return;
    }

    // activeWolGeneration is already set to generation by handleSetInternal
    // before calling this method — no need to set it again here.

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
      this.log.warn('All WOL send attempts failed (socket/network error). Proceeding with verification — the first packet may still have been transmitted before the error.');
    } else {
      this.log.info(`WOL packets sent (${successCount}/3 succeeded). UDP has no acknowledgement — proceeding to verify boot for up to ${this.wolVerifyDelay / 1000}s.`);
    }

    // Guard: a new action may have arrived during the 400ms send window.
    // If the generation is stale, skip verification entirely — scheduleVerify
    // would exit immediately anyway, but this keeps the pattern explicit.
    if (this.destroyed || !this.isWolWindowActive()) return;

    // Use retry count instead of wall clock deadline — Date.now() is not monotonic
    // and can jump backward on NTP slew or clock changes, causing premature expiry.
    // Math.max(1,...) ensures at least one verification attempt even if wolVerifyDelay
    // is set below WOL_VERIFY_RETRY_MS (e.g. 1-4s), preventing immediate OFF report.
    const maxRetries = Math.max(1, Math.floor(this.wolVerifyDelay / WOL_VERIFY_RETRY_MS));
    let retryCount = 0;

    const scheduleVerify = (): void => {
      // isWolWindowActive() returns false if wolVerifyGeneration incremented (new action),
      // so no manual activeWolGeneration nullification is needed in each callback.
      if (this.destroyed || !this.isWolWindowActive()) return;

      if (retryCount >= maxRetries) {
        this.activeWolGeneration = null;
        this.log.warn('WOL verify deadline reached — target did not respond. Reporting OFF.');
        this.currentState = false;
        this.service.updateCharacteristic(this.platform.api.hap.Characteristic.On, false);
        this.wolVerifyTimer = null;
        return;
      }

      const timer = setTimeout(async () => {
        this.wolVerifyTimer = null;
        retryCount++;
        if (this.destroyed || !this.isWolWindowActive()) return;

        try {
          const alive = await this.ssh.isAlive();
          if (this.destroyed || !this.isWolWindowActive()) return;

          if (alive) {
            this.activeWolGeneration = null;
            this.log.info('Post-WOL check: target is UP');
            if (this.currentState !== true) {
              this.currentState = true;
              this.service.updateCharacteristic(this.platform.api.hap.Characteristic.On, true);
            }
          } else {
            this.log.info(`Post-WOL check: target still offline. Retrying in ${WOL_VERIFY_RETRY_MS / 1000}s... (${retryCount}/${maxRetries})`);
            scheduleVerify();
          }
        } catch (err) {
          if (this.destroyed || !this.isWolWindowActive()) return;
          this.log.warn(`Post-WOL verify error: ${(err as Error).message}. Retrying...`);
          scheduleVerify();
        }
      }, Math.max(0, WOL_VERIFY_RETRY_MS)); // Math.max guards future-proofing if constant ever changes
      timer.unref(); // allow clean process exit during long verify windows
      this.wolVerifyTimer = timer;
    };

    scheduleVerify();
  }

  // ── Shutdown ─────────────────────────────────────────────────────────────────

  private async handleShutdown(generation: number): Promise<void> {
    this.log.info(`Sending shutdown via SSH`);
    try {
      await this.ssh.exec(this.shutdownCommand, true);
      if (this.destroyed) return;
      this.log.info(`Shutdown command sent.`);
    } catch (err) {
      if (this.destroyed) return;
      const e = err as NodeJS.ErrnoException;
      const isExpectedDrop =
        e.code === 'ECONNRESET' || e.code === 'EPIPE' ||
        e.code === 'ECONNABORTED' || e.code === 'ENOTCONN' ||
        e.code === 'ECONNREFUSED' || e.code === 'EHOSTUNREACH';
      const isAmbiguousTimeout = err instanceof AmbiguousTimeoutError;
      const isNonZeroExit = err instanceof CommandExitError;

      if (isExpectedDrop || isAmbiguousTimeout) {
        this.log.info(`SSH connection dropped or target unreachable during shutdown (${e.code ?? 'timeout'}). Polling will confirm.`);
      } else if (isNonZeroExit) {
        this.log.info(`Shutdown command exited with non-zero code (${(err as CommandExitError).exitCode}) — treating as ambiguous. Polling will confirm.`);
      } else {
        this.log.error(`Shutdown failed: ${e.message}`);
        this.revertState(true, 'shutdown command failed');
        return;
      }
    }

    if (this.destroyed) return;

    // Guard against a queued WOL action that started while this SSH exec was in-flight.
    // If wolVerifyGeneration has advanced, a new action is already running — setting
    // the cooldown timer here would suppress polling during the active WOL window.
    if (this.wolVerifyGeneration !== generation) return;

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
    if (this.isWolWindowActive() || this.shutdownCooldownTimer !== null) {
      this.schedulePoll();
      return;
    }

    this.isPolling = true;
    try {
      const alive = await this.ssh.isAlive();
      this.consecutiveFailures = 0;

      // Re-check guards after the async gap — a user may have toggled the switch
      // while we were waiting for the TCP probe. Uses isWolWindowActive() for
      // consistency with the pre-poll guard above.
      if (this.destroyed || this.isWolWindowActive() || this.shutdownCooldownTimer !== null) {
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

  /**
   * Returns true when a WOL verification window is active for the current generation.
   * Using this derived check instead of manual activeWolGeneration nullification in
   * every callback means a new action (increment to wolVerifyGeneration) instantly
   * invalidates all previous callbacks without requiring explicit cleanup in each one.
   */
  private isWolWindowActive(): boolean {
    return this.activeWolGeneration !== null &&
      this.activeWolGeneration === this.wolVerifyGeneration;
  }

  private revertState(state: boolean, reason?: string): void {
    if (!this.destroyed) {
      this.log.warn(`State reverted to ${state ? 'ON' : 'OFF'}${reason ? ` — ${reason}` : ''}`);
      this.currentState = state;
      this.service.updateCharacteristic(this.platform.api.hap.Characteristic.On, state);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    t.unref(); // allow process to exit cleanly during WOL inter-packet delays
  });
}
