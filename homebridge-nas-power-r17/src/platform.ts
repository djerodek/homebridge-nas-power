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

    const configuredUuids = new Set(
      devices.map(d =>
        this.api.hap.uuid.generate(d.uuidOverride ?? d.mac ?? d.name + d.host),
      ),
    );

    // Remove accessories no longer in config
    const stale = this.cachedAccessories.filter(a => !configuredUuids.has(a.UUID));
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} stale accessory/accessories no longer in config`);
      this.unregisterPlatformAccessories(stale);
    }

    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(
        device.uuidOverride ?? device.mac ?? device.name + device.host,
      );

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
          this.log.info('Adding new accessory:', device.name);
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
