# Changelog

All notable changes to homebridge-nas-power are documented here.

---

## [0.1.11] - 2026-06-21

### Fixed
- `package.json` — `changelog` URL updated to `latest` branch so Homebridge UI can retrieve and display release notes correctly
- `platform.ts` — Accessory rename no longer mutates `displayName` directly (unreliable across Homebridge versions); stores name in `context.configName` and calls `updatePlatformAccessories()` — prevents silent cache desynchronisation on restart
- `accessory.ts` — `stateQueue` reset comment corrected — clarifies that pending tasks still execute as no-ops rather than being cancelled
- `accessory.ts` — Stale generation check added after WOL send loop before `scheduleVerify()` — consistent with guard pattern used elsewhere
- `accessory.ts` — `wolVerifyDelay` runtime guard raised from `>= 1` to `>= 5` to match schema minimum of 5s
- `accessory.ts` — `stateQueue` reset to `Promise.resolve()` in `destroy()` — allows chain to be GC'd after pending tasks complete
- `accessory.ts` — WOL log messages now distinguish between a socket/network send error and the expected absence of UDP acknowledgement
- `ssh.ts` — `getHostKeyIdentifier()` helper added — IPv6 addresses stored as `[host]:port` in known hosts file, preventing colon-collision parsing failures; strips existing brackets to prevent `[[::1]]:22` double-wrapping
- `ssh.ts` — SSH key mismatch error now uses wildcard `ssh_host_*_key.pub` covering RSA, ECDSA, and Ed25519 key types
- `ssh.ts` — `split(' ', 2)` in `loadKnownFingerprint` makes two-field intent explicit and handles extra whitespace in manually edited files
- `config.schema.json` — MAC address pattern relaxed to accept hyphens and un-delimited hex formats; description notes mixed delimiters are accepted but not recommended
- `config.schema.json` — `wolVerifyDelay` minimum raised from 1s to 5s — ensures at least one verification check fires
- `config.schema.json` — `wolBroadcastAddress` description now explicitly warns against entering a unicast device IP — must be a broadcast address ending in `.255`
- `README.md` — Known hosts format updated to document bracket notation for IPv6 and wildcard key verification command
- `README.md` — `wolVerifyDelay` table entry notes minimum 5s

---

## [0.1.10] - 2026-06-09

### Changed
- Version bump for npm publish — no code changes from 0.1.9

---

## [0.1.9] - 2026-06-09

### Fixed
- `package.json` — `changelog` URL updated to `latest` branch so Homebridge UI can retrieve and display release notes correctly
- `platform.ts` — Accessory rename no longer mutates `displayName` directly (unreliable across Homebridge versions); stores name in `context.configName` and calls `updatePlatformAccessories()` — prevents silent cache desynchronisation on restart
- `accessory.ts` — `stateQueue` reset comment corrected — clarifies that pending tasks still execute as no-ops rather than being cancelled
- `accessory.ts` — Stale generation check added after WOL send loop before `scheduleVerify()` — consistent with guard pattern used elsewhere
- `accessory.ts` — `wolVerifyDelay` runtime guard raised from `>= 1` to `>= 5` to match schema minimum of 5s
- `accessory.ts` — `stateQueue` reset to `Promise.resolve()` in `destroy()` — allows chain to be GC'd after pending tasks complete
- `ssh.ts` — `getHostKeyIdentifier()` helper added — IPv6 addresses stored as `[host]:port` in known hosts file, preventing colon-collision parsing failures; strips existing brackets to prevent `[[::1]]:22` double-wrapping
- `ssh.ts` — SSH key mismatch error now uses wildcard `ssh_host_*_key.pub` covering RSA, ECDSA, and Ed25519 key types
- `ssh.ts` — `split(' ', 2)` in `loadKnownFingerprint` makes two-field intent explicit and handles extra whitespace in manually edited files
- `config.schema.json` — MAC address pattern relaxed to accept hyphens and un-delimited hex formats; description notes mixed delimiters are accepted but not recommended
- `config.schema.json` — `wolVerifyDelay` minimum raised from 1s to 5s to match retry interval — ensures at least one verification check fires
- `README.md` — Known hosts format updated to document bracket notation for IPv6 and wildcard key verification command
- `README.md` — `wolVerifyDelay` table entry notes minimum 5s

---

## [0.1.10] - 2026-06-09

### Changed
- Version bump for npm publish — no code changes from 0.1.9

---

## [0.1.9] - 2026-06-09

### Fixed
- `ssh.ts` — `getHostKeyIdentifier()` helper added — IPv6 addresses now stored as `[host]:port` in known hosts file, preventing colon-collision parsing failures
- `ssh.ts` — SSH key mismatch error now uses wildcard `ssh_host_*_key.pub` path hint, covering RSA, ECDSA, and Ed25519 key types
- `config.schema.json` — MAC address pattern relaxed to accept hyphens and un-delimited hex formats (AA-BB-CC-DD-EE-FF, AABBCCDDEEFF)
- `accessory.ts` — `wolVerifyDelay` runtime guard raised from `>= 1` to `>= 5` to match schema minimum
- `accessory.ts` — `stateQueue` reset to `Promise.resolve()` in `destroy()` — prevents dangling chain executing no-op tasks after shutdown
- `package.json` — `"changelog"` field updated to raw GitHub URL so Homebridge UI can retrieve and display release notes
- `README.md` — Known hosts format section updated to document bracket notation for IPv6; key verification command updated to wildcard path

---

## [0.1.8] - 2026-06-08

### Fixed
- `accessory.ts` — `maxRetries` now uses `Math.max(1, ...)` guard — `wolVerifyDelay` values below 5s no longer cause immediate OFF report without a single connectivity check
- `accessory.ts` — `activeWolGeneration` now explicitly cleared on no-MAC early return in `handleWakeOnLan` — previously polling was suppressed until next user toggle
- `accessory.ts` — Redundant `activeWolGeneration` assignment removed from `handleWakeOnLan` — `handleSetInternal` already sets it before calling
- `accessory.ts` — Post-async poll guard now uses `isWolWindowActive()` for consistency with pre-poll guard
- `accessory.ts` — `handleShutdown` now accepts `generation` parameter and checks it before setting cooldown timer — prevents suppressing polling during an active WOL window when a queued shutdown completes after a subsequent WOL
- `accessory.ts` — `err instanceof Error` check replaces `(err as Error).message ?? String(err)` in queue catch handler — the `??` branch was unreachable
- `accessory.ts` — `delay()` helper now calls `.unref()` on its timer for consistency with other timers
- `accessory.ts` — Device-prefixed logger now passed to `SshManager` — SSH log entries correctly attributed to device in multi-device setups
- `platform.ts` — Accessory `displayName` synced when config `name` changes — no longer requires cache wipe to reflect rename
- `config.schema.json` — `wolVerifyDelay` minimum raised from 1s to 5s — matches retry interval, ensures at least one verification fires
- `README.md` — IPv6 addresses documented as unsupported for `host` field due to known hosts file format collision
- `README.md` — `wolVerifyDelay` table entry notes minimum 5s

---

## [0.1.7] - 2026-06-07

### Added
- `README.md` — Dedicated low-privilege SSH user setup documented as best practice; includes step-by-step instructions for creating a `homebridge` user restricted to running only the shutdown command via sudo

### Fixed
- `accessory.ts` — Added `isWolWindowActive()` helper method — replaces five scattered `activeWolGeneration` manual cleanup sites in `scheduleVerify` callbacks with a single derived check; stale callbacks are now automatically invalidated when `wolVerifyGeneration` increments
- `accessory.ts` — `activeWolGeneration` explicitly set on WOL path and nulled on shutdown path in `handleSetInternal` for clarity
- `platform.ts` — Auth field validation added to `discoverDevices()` — devices missing both `password` and `privateKeyPath` are now skipped with a clear error log at config-load time rather than failing inside the accessory constructor
- `config.schema.json` — `uuidOverride` now enforces `minLength: 1` — empty string no longer silently produces a valid but unintended UUID
- `ssh.ts` — `exec()` error now includes the command name and both stderr/stdout in the message for easier diagnosis
- `ssh.ts` — `EHOSTDOWN` and `ENETUNREACH` in `isAlive()` now documented with comments explaining why they resolve false rather than reject
- `CHANGELOG.md` — Added missing 0.1.6 entry

---

## [0.1.6] - 2026-06-04

### Fixed
- `accessory.ts` — `isPolling` now reset to false in `destroy()`, preventing silent no-op if accessory is immediately re-registered
- `accessory.ts` — `consecutiveFailures` reset moved from `revertState` to WOL path only in `handleSetInternal` — prevents wiping backoff on genuine shutdown failures
- `accessory.ts` — WOL verify deadline replaced with retry count — avoids `Date.now()` wall clock jump causing premature expiry on NTP slew
- `accessory.ts` — WOL verify `setTimeout` now calls `.unref()` — allows clean process exit during long verify windows
- `accessory.ts` — `Math.max(0, WOL_VERIFY_RETRY_MS)` guards against negative timer delay
- `accessory.ts` — `retryIntervalMs` alias removed — `WOL_VERIFY_RETRY_MS` constant used directly
- `accessory.ts` — `handleShutdown()` returns early if `destroyed` after SSH await — prevents cooldown timer being set after destruction
- `accessory.ts` — `schedulePoll()` now checks `destroyed` at top — self-contained guard
- `accessory.ts` — `pollTimer` and `shutdownCooldownTimer` call `.unref()` for clean process exit
- `accessory.ts` — `revertState` no longer resets `consecutiveFailures`
- `wol.ts` — `socket 'error'` handler routes through `done()` instead of calling `reject()` directly — respects `settled` flag
- `ssh.ts` — `ENETUNREACH` added to `isAlive()` resolve-false list — local interface drops no longer trigger backoff
- `ssh.ts` — Known hosts file format documented as plugin-specific, not standard OpenSSH format
- `ssh.ts` — OMV-specific reference removed from fingerprint mismatch error message

---

## [0.1.5] - 2026-06-04

### Added
- `CHANGELOG.md` added to repository and included in npm package

---

## [0.1.4] - 2026-06-02

### Fixed
- `exec()` in `ssh.ts` — attached no-op `.catch()` to the underlying `execCommand` promise to prevent unhandled rejection warnings after `ssh.dispose()` is called when the timeout wins the race
- `sendWol()` in `wol.ts` — added `settled` boolean flag to prevent `done()` being called twice if the send timeout fires while the socket bind callback is still pending
- Config schema — removed `maximum` constraints from all numeric fields (`port`, `pollInterval`, `wolVerifyDelay`, `shutdownCooldownDelay`, `execTimeout`) so the Homebridge UI renders text inputs instead of sliders

---

## [0.1.3] - 2026-06-02

### Added
- macOS support documented — plugin works with any SSH-enabled macOS machine using the default `sudo shutdown -h now` command
- `macos` keyword added to `package.json`
- README: macOS listed as a tested platform; Requirements section notes "Wake for network access" must be enabled; SSH Sudo Setup section split into Linux and macOS instructions

### Fixed
- `platform.ts` — devices are now validated before the UUID set is built, preventing malformed config entries (missing or non-string `name`/`host`) from generating ghost UUIDs like `"undefinedundefined"` that blocked stale accessory cleanup
- `accessory.ts` — runtime check for both `password` and `privateKeyPath` being set now casts to `Record<string, unknown>` to avoid a TypeScript compiler error caused by the discriminated union making the check appear unreachable

---

## [0.1.2] - 2026-06-01

### Changed
- Removed all OpenMediaVault-specific references throughout the codebase to make the plugin platform-agnostic
- `manufacturer` accessory default changed from `OpenMediaVault` to `NAS`
- README updated to reflect compatibility with any Linux-based NAS (OpenMediaVault, TrueNAS SCALE, Unraid, Ubuntu/Debian)
- `package.json` description and keywords updated accordingly

---

## [0.1.1] - 2026-05-31

### Fixed
- `platform.ts` — malformed config entries (non-string or missing `name`/`host`) no longer crash the plugin with a `TypeError: The "data" argument must be of type string` error; invalid devices are skipped with a clear error log
- `platform.ts` — UUID source safely coerced to string before passing to `uuid.generate()` to prevent NaN crashes
- `accessory.ts` — `activeWolGeneration` now cleared when `wolVerifyTimer` is cancelled on shutdown toggle, preventing polling from being blocked indefinitely
- `accessory.ts` — WOL send attempts are now individual — all three packets are attempted regardless of individual failures, with verification always proceeding; previously a single send error aborted the entire sequence
- `platform.ts` — multi-argument `log.info()` calls replaced with template literals for consistency

---

## [0.1.0] - 2026-05-31

### Initial release

- HomeKit switch to wake a NAS via Wake-on-LAN and shut it down via SSH
- SSH host key verification using Trust On First Use (TOFU) with persistent fingerprint storage
- TCP port polling for lightweight power state detection (no full SSH handshake per poll)
- Exponential backoff on consecutive poll failures up to 5 minutes
- Serialized state queue prevents overlapping WOL and shutdown commands
- Generation counter prevents stale WOL verification callbacks from corrupting UI state
- WOL verification retry loop — retries every 5 seconds until deadline rather than a single check
- Shutdown cooldown suppresses polling while NAS is powering down
- Optimistic UI updates with automatic revert on failure
- Configurable: `pollInterval`, `wolVerifyDelay`, `shutdownCooldownDelay`, `execTimeout`, `wolBroadcastAddress`, `knownHostsPath`, `uuidOverride`
- Supports password and private key SSH authentication
- Multi-device support via `devices` array
- Stale accessory cleanup on config change
- Duplicate UUID detection with clear error logging
