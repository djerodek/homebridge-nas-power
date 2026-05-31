import { WolOptions } from './types';
/**
 * Send a Wake-on-LAN magic packet to the given MAC address.
 * @param mac  - MAC address in any common format (colon, dash, or plain hex)
 * @param opts - Optional: { address, port }
 * Note: WOL uses IPv4 UDP broadcast. IPv6-only networks are not supported.
 */
export declare function sendWol(mac: string, opts?: WolOptions): Promise<void>;
//# sourceMappingURL=wol.d.ts.map