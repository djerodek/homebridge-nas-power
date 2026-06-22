# homebridge-nas-power

Homebridge plugin to expose your NAS as a switch in Apple HomeKit.

- **ON** → Sends Wake-on-LAN magic packets, then retries SSH port check until the NAS responds
- **OFF** → Connects via SSH and runs a shutdown command
- **State** → Detected by polling SSH port connectivity (TOFU host key verification)

Works with any Linux-based NAS or macOS machine that has SSH enabled (tested on OpenMediaVault, TrueNAS SCALE, Unraid, standard Ubuntu/Debian servers, and macOS).

## Maintenance Status

This project is **unmaintained**. The original author has no plans to actively maintain or update it. You are welcome to fork this repository and continue development at your leisure.

---

## Requirements

- Homebridge ≥ 1.6.0
- Node.js ≥ 18
- SSH enabled on your target machine
- The SSH user must have permission to run the shutdown command (see below)
- WOL enabled in your machine's BIOS/UEFI and network switch (only required for power-on)
- **macOS targets:** Enable "Wake for network access" in System Settings → Energy

---

## Installation

```bash
npm install -g homebridge-nas-power
```

Or install via the Homebridge UI by searching `homebridge-nas-power`.

---

## SSH Sudo Setup

The plugin runs `sudo shutdown -h now` over SSH by default. Allow this without a password prompt:

### Best Practice — Dedicated Low-Privilege User

Rather than granting sudo shutdown access to your main admin account, create a dedicated user that can **only** run the shutdown command and nothing else. This limits exposure if the credentials are ever compromised.

**Create the user:**

```bash
sudo adduser homebridge
```

Set a password when prompted.

**Allow only the shutdown command via sudo:**

```bash
sudo nano /etc/sudoers.d/homebridge
```

Add this single line:

```
homebridge ALL=(ALL) NOPASSWD: /sbin/shutdown
```

Save with `Ctrl+O`, Enter, exit with `Ctrl+X`. Then lock down the file permissions:

```bash
sudo chmod 440 /etc/sudoers.d/homebridge
```

**Verify it works:**

```bash
su - homebridge
sudo /sbin/shutdown --help
```

Should show help without asking for a password. Then:

```bash
exit
```

**Restart SSH:**

```bash
sudo systemctl restart ssh
```

**Update your Homebridge config to use the full path and dedicated user:**

```json
"username": "homebridge",
"password": "yourpassword",
"shutdownCommand": "sudo /sbin/shutdown -h now"
```

> **Note:** The `homebridge` user has no sudo access to any other command — even if the credentials are obtained, an attacker can only shut down the machine, not gain elevated access.

### Linux / NAS (existing admin user)

If you prefer to use your existing admin account, allow passwordless shutdown:

1. Verify the path to `shutdown` on your system:

```bash
which shutdown
```

2. Run `visudo` and add:

```
yourusername ALL=(ALL) NOPASSWD: /sbin/shutdown, /usr/sbin/shutdown
```

> **Note:** On modern systemd-based systems, `sudo systemctl poweroff` is often more reliable. Set this via the `shutdownCommand` config option.

### macOS

macOS requires `sudo` to be configured for passwordless shutdown. Run:

```bash
sudo visudo
```

Add:

```
yourusername ALL=(ALL) NOPASSWD: /sbin/shutdown
```

The default `sudo shutdown -h now` command works on macOS without any changes to `shutdownCommand`.

---

## SSH Authentication

One of `password` or `privateKeyPath` is required. Private key auth is strongly recommended.

### Password auth

Set `username` and `password` in your device config.

### Private key auth (recommended)

1. Generate a key pair on your Homebridge host:

```bash
ssh-keygen -t ed25519 -f ~/.homebridge/nas_key -C "homebridge-nas-power"
```

2. Copy the public key to your NAS:

```bash
ssh-copy-id -i ~/.homebridge/nas_key.pub yourusername@192.168.1.100
```

3. Set `privateKeyPath` in your device config.

> **Note:** The private key is cached in memory at startup. If you rotate the key file on disk while Homebridge is running, the plugin will continue using the old key until Homebridge is restarted.

---

## Security: Shutdown Command

The `shutdownCommand` config value is executed directly on the NAS over SSH without sanitization. **Only use trusted values here.** Do not expose your Homebridge `config.json` to untrusted users.

---

## Homebridge config.json

### Password authentication example

```json
{
  "platforms": [
    {
      "platform": "NasPower",
      "name": "NAS Power",
      "devices": [
        {
          "name": "NAS",
          "host": "192.168.1.100",
          "mac": "AA:BB:CC:DD:EE:FF",
          "port": 22,
          "username": "admin",
          "password": "yourpassword",
          "shutdownCommand": "sudo shutdown -h now",
          "pollInterval": 30
        }
      ]
    }
  ]
}
```

### Private key authentication example (recommended)

```json
{
  "platforms": [
    {
      "platform": "NasPower",
      "name": "NAS Power",
      "devices": [
        {
          "name": "NAS",
          "host": "192.168.1.100",
          "mac": "AA:BB:CC:DD:EE:FF",
          "port": 22,
          "username": "admin",
          "privateKeyPath": "/home/homebridge/.homebridge/nas_key",
          "shutdownCommand": "sudo shutdown -h now",
          "pollInterval": 30
        }
      ]
    }
  ]
}
```

### Config options

| Field | Required | Default | Description |
|---|---|---|---|
| `name` | Yes | — | Display name in HomeKit |
| `host` | Yes | — | NAS IP address or hostname |
| `mac` | No | — | MAC address for WOL. If omitted, power-on is unavailable |
| `port` | No | `22` | SSH port |
| `username` | Yes | — | SSH username |
| `password` | Conditional | — | SSH password. Required if `privateKeyPath` not set |
| `privateKeyPath` | Conditional | — | Path to SSH private key. Required if `password` not set |
| `passphrase` | No | — | Passphrase for an encrypted private key. Only meaningful when `privateKeyPath` is set |
| `shutdownCommand` | No | `sudo shutdown -h now` | Command to run over SSH to shut down the NAS |
| `pollInterval` | No | `30` | Seconds between state polls (min 5) |
| `wolVerifyDelay` | No | `10` | Duration in seconds of the boot verification window after WOL. The plugin retries every 5s within this window — minimum 5s. Increase for slow-booting hardware |
| `shutdownCooldownDelay` | No | `30` | Seconds to suppress polling after a shutdown command to prevent the switch flickering back to ON. Cancelled immediately if the user toggles the switch again |
| `execTimeout` | No | `30` | Seconds to wait for the SSH shutdown command before timing out. Increase for slow-shutting hardware |
| `wolBroadcastAddress` | No | `255.255.255.255` | WOL broadcast address. Change for VLAN setups. IPv4 only — WOL does not support IPv6 |
| `uuidOverride` | No | — | Advanced: manually specify the UUID seed string for this device. Use when you need a stable UUID that is independent of MAC address or name/host — for example, to rename a device without losing HomeKit history |
| `knownHostsPath` | No | `$HOMEBRIDGE_USER_STORAGE_PATH/nas-power-known-hosts` | Path for SSH fingerprint storage. The directory is created automatically if it does not exist |
| `manufacturer` | No | `NAS` | Shown in HomeKit accessory info |
| `model` | No | `NAS` | Shown in HomeKit accessory info |
| `firmwareRevision` | No | — | Shown in HomeKit accessory info |
| `hardwareRevision` | No | — | Shown in HomeKit accessory info |

> **UUID stability:** Each device's HomeKit UUID is derived from its MAC address. If no MAC is provided, the UUID falls back to `name + host`. Changing the name or IP without a MAC causes HomeKit to treat it as a new accessory. Providing a MAC is strongly recommended.

---

## SSH Host Key Verification

The plugin uses Trust On First Use (TOFU). On first connection it stores the host's SHA256 fingerprint. All subsequent connections verify against it, protecting against MITM attacks.

**Known-hosts file format:** Each line stores one host entry:

```
host:port SHA256:base64encodedfingerprint
```

IPv4 example:
```
192.168.1.100:22 SHA256:AbCdEf1234...
```

IPv6 example (bracket notation used automatically):
```
[fe80::1]:22 SHA256:AbCdEf1234...
```

You can pre-populate this file manually for scripted deployments, or delete individual lines to force re-verification of a specific host.

> **IPv6 note:** IPv6 addresses are stored using bracket notation `[host]:port` to avoid colon-collision in the file format. However, IPv6 target addresses have limited testing — IPv4 is recommended for the `host` field.

If the fingerprint changes legitimately (e.g. after reinstalling your NAS OS), verify the new key with:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub
```

Then delete the stored fingerprints and restart Homebridge:

```bash
rm $HOMEBRIDGE_USER_STORAGE_PATH/nas-power-known-hosts
sudo systemctl restart homebridge
```

---

## Understanding State

### What "OFF" means

**"OFF" means SSH port unreachable — not necessarily powered off.** The following all appear identical to the plugin:

- NAS is powered off
- NAS is booting (SSH not yet started)
- SSH daemon has crashed
- Firewall blocking port 22
- Network unreachable

After 3 consecutive TCP failures the plugin reports OFF regardless of last known state — this handles hard power cuts so the switch doesn't stay stuck ON indefinitely.

> **Note:** State is determined by a raw TCP port check, not a full SSH handshake. A device spoofing your NAS IP on port 22 would cause the plugin to report ON. Host key verification only applies to SSH shutdown commands. This is an acceptable trade-off for home networks.

### Optimistic updates

- The switch updates **immediately** when toggled — HomeKit gets instant feedback.
- Verification (WOL retry loop or polling) corrects the state if the action fails.
- When a power-on or shutdown attempt fails, the plugin reverts the switch and logs the reason (e.g. WOL failure, SSH failure).
- Automations may briefly see the optimistic state before verification completes.

### WOL verification behavior

When power-on is triggered:

1. Sends 3 magic packets with 200ms spacing.
2. Starts a verification window (`wolVerifyDelay` seconds).
3. **Polling is blocked immediately** — the plugin sets a guard before sending packets to prevent the poll from flickering the switch to OFF during the send window.
4. Retries `isAlive()` every 5 seconds until:
   - NAS responds → switch stays ON
   - Deadline expires → switch reverts to OFF and polling resumes

This means a NAS that takes 45 seconds to boot will be detected correctly as long as `wolVerifyDelay` is set high enough (default 10s — increase for slow hardware).

### Shutdown behavior

- The shutdown command is sent over SSH.
- Most Linux NAS systems drop the SSH connection mid-shutdown — this is expected and treated as success, not an error.
- Shutdown success is **not** verified by SSH exit code alone — the plugin relies on subsequent polling to confirm the NAS is offline.
- Polling is suppressed for `shutdownCooldownDelay` seconds (default 30s) after the command is sent to prevent the switch flickering back to ON while the NAS powers down.
- If the user toggles the switch during the cooldown window, the cooldown is cancelled immediately and the new action proceeds.

### Polling and backoff

- Polling checks SSH port reachability every `pollInterval` seconds (default 30s).
- Polling is **suspended** during WOL verification and shutdown cooldown windows.
- On consecutive failures, polling uses **exponential backoff** (interval × 2ⁿ) up to a maximum of 5 minutes, reducing network load during extended downtime.
- On the next successful check or user-initiated action, the backoff resets.

### Transition latency

The HomeKit switch updates optimistically (immediately on user action). Actual state changes take time — shutdown may take 30s to several minutes; boot typically 30–120s depending on hardware.

**HomeKit automation note:** Because `handleSet` returns immediately (to prevent the Home app spinner), HomeKit automations may briefly see a false-positive state before verification corrects it. This is a deliberate UX trade-off — the switch feels instantaneous but HomeKit loses direct transactional feedback. The optimistic update is corrected by WOL verification and polling within seconds.

---

## Wake-on-LAN Troubleshooting

- **Wi-Fi:** Many wireless adapters do not support WOL. Homebridge should be on wired ethernet.
- **Managed switches:** May require WOL to be explicitly enabled per-port.
- **Energy Efficient Ethernet (EEE):** Can interfere with WOL. Disable in NAS network adapter settings.
- **VLAN isolation:** Magic packets won't cross VLAN boundaries. Use `wolBroadcastAddress` with a subnet-directed broadcast (e.g. `192.168.1.255`).
- **Router blocking broadcasts:** Use a directed broadcast address instead of `255.255.255.255`.
- **Slow-booting hardware:** Increase `wolVerifyDelay` beyond the default 10s. The plugin retries every 5s until the deadline, so a value of 60–120s covers most hardware.

---

## Notes

- The plugin supports multiple NAS devices — add additional entries to the `devices` array.
- Most Linux NAS systems drop the SSH connection during shutdown — the plugin treats this as expected, not an error.
- WOL uses IPv4 UDP broadcast only. IPv6-only networks are not supported.
