import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';
export declare const PLATFORM_NAME = "NasPower";
export declare const PLUGIN_NAME = "homebridge-nas-power";
export declare class NasPowerPlatform implements DynamicPlatformPlugin {
    readonly log: Logger;
    readonly api: API;
    private readonly config;
    private cachedAccessories;
    private readonly nasAccessories;
    constructor(log: Logger, config: PlatformConfig, api: API);
    configureAccessory(accessory: PlatformAccessory): void;
    unregisterPlatformAccessories(accessories: PlatformAccessory[]): void;
    private discoverDevices;
}
//# sourceMappingURL=platform.d.ts.map