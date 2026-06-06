"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendWol = sendWol;
const dgram = __importStar(require("dgram"));
const WOL_SEND_TIMEOUT_MS = 5000;
/**
 * Send a Wake-on-LAN magic packet to the given MAC address.
 * @param mac  - MAC address in any common format (colon, dash, or plain hex)
 * @param opts - Optional: { address, port }
 * Note: WOL uses IPv4 UDP broadcast. IPv6-only networks are not supported.
 */
function sendWol(mac, opts = {}) {
    return new Promise((resolve, reject) => {
        if (typeof mac !== 'string') {
            return reject(new Error(`MAC address must be a string, got ${typeof mac}`));
        }
        const cleanMac = mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
        if (!/^[0-9a-f]{12}$/.test(cleanMac)) {
            return reject(new Error(`Invalid MAC address: ${mac}`));
        }
        // Build magic packet: 6x 0xFF + 16x MAC
        const macBuffer = Buffer.from(cleanMac, 'hex');
        const packet = Buffer.alloc(102);
        packet.fill(0xff, 0, 6);
        for (let i = 0; i < 16; i++) {
            macBuffer.copy(packet, 6 + i * 6, 0, 6);
        }
        const address = opts.address ?? '255.255.255.255';
        const port = opts.port ?? 9;
        if (typeof address !== 'string' || address.trim() === '') {
            return reject(new Error(`Invalid WOL broadcast address: "${address}"`));
        }
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            return reject(new Error(`Invalid WOL port: ${port}. Must be an integer between 1 and 65535.`));
        }
        const socket = dgram.createSocket('udp4');
        // Guard against double-close race on some Node versions/platforms
        let closed = false;
        function safeClose() {
            if (!closed) {
                closed = true;
                socket.close();
            }
        }
        // settled flag prevents done() from being called twice — the timeout may
        // fire and reject the promise while the bind callback is still pending,
        // causing a second invocation of done() on an already-settled promise.
        let settled = false;
        // Timeout guard — if the socket gets into a bad state the Promise would
        // never settle without this. Rare on LAN but plugins run for months/years.
        const sendTimeout = setTimeout(() => {
            done(new Error('WOL send timeout'));
        }, WOL_SEND_TIMEOUT_MS);
        function done(err) {
            if (settled)
                return;
            settled = true;
            clearTimeout(sendTimeout);
            safeClose();
            if (err) {
                reject(err);
            }
            else {
                resolve();
            }
        }
        socket.once('error', (err) => {
            done(err);
        });
        // Wrap bind() in try/catch — on some platforms/states it can throw synchronously,
        // which would leave the Promise permanently unresolved without this guard.
        try {
            socket.bind(() => {
                try {
                    socket.setBroadcast(true);
                }
                catch (err) {
                    done(err);
                    return;
                }
                socket.send(packet, 0, packet.length, port, address, (err) => {
                    done(err);
                });
            });
        }
        catch (err) {
            clearTimeout(sendTimeout);
            safeClose();
            reject(err);
        }
    });
}
//# sourceMappingURL=wol.js.map