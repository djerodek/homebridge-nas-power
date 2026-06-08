import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';
import { NasAccessory } from './accessory';
import { DeviceConfig, PluginConfig } from './types';

export const PLATFORM_NAME = 'NasPower';
export const PLUGIN_NAME = 'homebridge-nas-power';

export class NasPowerPlatform implements DynamicPlatformPlugin {
  public readonly log: Logger;
  public readonly api: API;

  private readonly config: PluginConfig;
  private cachedAccessories: PlatformAccessory[] = [];
  private readonly nasAccessories = new Map<string, NasAccessory>();

  constructor(log: Logger, config: PlatformConfig, api: API) {
    this.log = log;
    this.api = api;
    this.config = config as unknown as PluginConfig;

    if (!config) return;

    this.api.on('didFinishLaunching', () => this.discoverDevices());
    this.api.on('shutdown', () => {
      for (const wrapper of this.nasAccessories.values()) wrapper.destroy();
      this.nasAccessories.clear();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.push(accessory);
  }

  unregisterPlatformAccessories(accessories: PlatformAccessory[]): void {
    for (const accessory of accessories) {
      const wrapper = this.nasAccessories.get(accessory.UUID);
      if (wrapper) {
        wrapper.destroy();
        this.nasAccessories.delete(accessory.UUID);
      }
    }
    const toRemove = new Set(accessories);
    this.cachedAccessories = this.cachedAccessories.filter(a => !toRemove.has(a));
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories);
  }

  private discoverDevices(): void {
    const devices: DeviceConfig[] = this.config.devices ?? [];

    // Build safe UUID source — coerce to string to prevent NaN crashing uuid.generate()
    const safeUuidSource = (d: DeviceConfig): string | null => {
      const raw = d.uuidOverride ?? d.mac ?? (d.name + d.host);
      if (raw === undefined || raw === null) return null;
      return typeof raw === 'string' ? raw : String(raw);
    };

    // Validate first — filter out malformed devices before building the UUID set.
    // Without this, safeUuidSource runs against undefined fields, producing ghost UUIDs
    // like "undefinedundefined" that prevent stale accessory cleanup from working correctly.
    const validDevices = devices.filter(device => {
      if (!device.name || typeof device.name !== 'string') {
        this.log.error(
          `[Platform] Device missing a valid "name" (must be a string). Found: ${String(device.name)}. Skipping.`,
        );
        return false;
      }
      if (!device.host || typeof device.host !== 'string') {
        this.log.error(
          `[Platform] Device "${device.name}" missing a valid "host" (must be a string). Skipping.`,
        );
        return false;
      }
      // Validate auth early so the error surfaces at config-load time rather than
      // inside the accessory constructor where it is harder to diagnose.
      const loose = device as Record<string, unknown>;
      if (!loose['password'] && !loose['privateKeyPath']) {
        this.log.error(
          `[Platform] Device "${device.name}" requires either "password" or "privateKeyPath". Skipping.`,
        );
        return false;
      }
      return true;
    });

    const configuredUuids = new Set(
      validDevices
        .map(d => safeUuidSource(d))
        .filter((s): s is string => s !== null)
        .map(s => this.api.hap.uuid.generate(s)),
    );

    // Remove accessories no longer in config
    const stale = this.cachedAccessories.filter(a => !configuredUuids.has(a.UUID));
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} stale accessory/accessories no longer in config`);
      this.unregisterPlatformAccessories(stale);
    }

    for (const device of validDevices) {
      // Build UUID source and coerce to string to handle any non-string config values
      const uuidSrc = safeUuidSource(device);
      if (uuidSrc === null) {
        this.log.error(
          `[Platform] Device "${device.name}" has no valid identifier (uuidOverride, mac, or name+host). Skipping.`,
        );
        continue;
      }
      const uuid = this.api.hap.uuid.generate(uuidSrc);

      // Duplicate UUID detection — same MAC or identical name+host combination.
      // Rather than silently overwriting (which leaves ghost polling timers), we
      // log a clear error and skip so the user knows to fix their config.
      if (this.nasAccessories.has(uuid)) {
        this.log.error(
          `[Platform] Duplicate device UUID for "${device.name}" — two devices share the same ` +
          'MAC address or name+host combination. The second entry has been skipped. Fix your config.',
        );
        continue;
      }

      const existingAccessory = this.cachedAccessories.find(a => a.UUID === uuid);
      try {
        if (existingAccessory) {
          this.log.info(`Restoring existing accessory: ${existingAccessory.displayName}`);
          const wrapper = new NasAccessory(this, existingAccessory, device);
          this.nasAccessories.set(uuid, wrapper);
        } else {
          this.log.info(`Adding new accessory: ${device.name}`);
          const accessory = new this.api.platformAccessory(device.name, uuid);
          const wrapper = new NasAccessory(this, accessory, device);
          this.nasAccessories.set(uuid, wrapper);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      } catch (err) {
        this.log.error(
          `Failed to initialise device "${device.name ?? device.host}": ${(err as Error).message}`,
        );
      }
    }
  }
}
