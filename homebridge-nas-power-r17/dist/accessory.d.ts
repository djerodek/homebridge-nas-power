import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { NasPowerPlatform } from './platform';
import { DeviceConfig } from './types';
export declare class NasAccessory {
    private readonly platform;
    private readonly accessory;
    private readonly service;
    private readonly ssh;
    private readonly name;
    private readonly mac?;
    private readonly shutdownCommand;
    private readonly wolBroadcastAddress;
    private readonly wolVerifyDelay;
    private readonly pollInterval;
    private readonly shutdownCooldownDelay;
    private pollTimer;
    private wolVerifyTimer;
    private activeWolGeneration;
    private shutdownCooldownTimer;
    private isPolling;
    private currentState;
    private consecutiveFailures;
    private destroyed;
    private wolVerifyGeneration;
    private readonly log;
    private stateQueue;
    constructor(platform: NasPowerPlatform, accessory: PlatformAccessory, config: DeviceConfig);
    private initialise;
    destroy(): void;
    handleGet(): Promise<CharacteristicValue>;
    handleSet(value: CharacteristicValue): Promise<void>;
    private handleSetInternal;
    private handleWakeOnLan;
    private handleShutdown;
    private poll;
    private schedulePoll;
    /**
     * Returns true when a WOL verification window is active for the current generation.
     * Using this derived check instead of manual activeWolGeneration nullification in
     * every callback means a new action (increment to wolVerifyGeneration) instantly
     * invalidates all previous callbacks without requiring explicit cleanup in each one.
     */
    private isWolWindowActive;
    private revertState;
}
//# sourceMappingURL=accessory.d.ts.map