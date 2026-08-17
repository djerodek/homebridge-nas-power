# Changelog

All notable changes to homebridge-nas-power are documented here.

---

## [0.1.13] - 2026-06-29

### Changed
- `accessory.ts`, `ssh.ts` — Log messages no longer say "NAS" — replaced with platform-agnostic "target" to reflect support for any SSH-enabled machine

---

## [0.1.12] - 2026-06-22

### Fixed
- `platform.ts` — Accessory rename regression fixed — restored direct `displayName` mutation; `context.configName` approach caused rename to re-fire on every restart
- `ssh.ts` — Bracket-wrapped IPv6 host values stripped at construction time — prevents silent connection failures
- `ssh.ts` — `CommandExitError` class added with typed `exitCode` property — replaces fragile string-match detection of non-zero exit codes
- `accessory.ts` — Non-zero shutdown exit codes caught via `instanceof CommandExitError` with dedicated log message distinct from SSH connection drops
- `accessory.ts` — Runtime port range validation — invalid port values produce a clear error
- `package.json` — Phantom `changelog` field removed; repository URL updated to `git+https` format
- `CHANGELOG.md` — Duplicate 0.1.9 and 0.1.10 entries removed

---

## [0.1.11] - 2026-06-21

### Fixed
- `platform.ts` — Accessory rename stores name in `context.configName` and calls `updatePlatformAccessories()`
- `accessory.ts` — `stateQueue` reset comment corrected; stale generation check added after WOL send loop
- `accessory.ts` — `wolVerifyDelay` runtime guard raised from `>= 1` to `>= 5` to match schema minimum
- `accessory.ts` — `stateQueue` reset to `Promise.resolve()` in `destroy()`
- `accessory.ts` — WOL log messages distinguish socket/network send errors from expected UDP no-acknowledgement
- `ssh.ts` — `getHostKeyIdentifier()` helper — IPv6 stored as `[host]:port`; strips existing brackets to prevent double-wrapping
- `ssh.ts` — SSH key mismatch error uses wildcard `ssh_host_*_key.pub`
- `ssh.ts` — `split(' ', 2)` in `loadKnownFingerprint`
- `config.schema.json` — MAC pattern relaxed to accept hyphens and un-delimited hex
- `config.schema.json` — `wolVerifyDelay` minimum raised to 5s; `wolBroadcastAddress` warns against unicast addresses
- `README.md` — Known hosts format updated; `wolVerifyDelay` table notes minimum 5s

---

## [0.1.10] - 2026-06-09

### Changed
- Version bump for npm publish — no code changes from 0.1.9

---

## [0.1.9] - 2026-06-09

### Fixed
- `package.json` — `changelog` field added pointing to raw GitHub URL
- `ssh.ts` — `getHostKeyIdentifier()` helper added; wildcard key path hint
- `config.schema.json` — MAC address pattern relaxed; `wolVerifyDelay` minimum raised to 5s
- `accessory.ts` — `wolVerifyDelay` runtime guard `>= 5`; `stateQueue` reset in `destroy()`
- `README.md` — Known hosts format and IPv6 notes added

---

## [0.1.8] - 2026-06-08

### Fixed
- `accessory.ts` — `maxRetries` `Math.max(1,...)` guard; `activeWolGeneration` cleared on no-MAC return; redundant assignment removed; post-async poll guard uses `isWolWindowActive()`; `handleShutdown(generation)` checks generation before setting cooldown; `err instanceof Error` in queue catch; `delay()` calls `.unref()`; device-prefixed logger passed to `SshManager`
- `platform.ts` — `displayName` synced on config rename
- `config.schema.json` — `wolVerifyDelay` minimum 5s
- `README.md` — IPv6 unsupported note; `wolVerifyDelay` minimum noted

---

## [0.1.7] - 2026-06-07

### Added
- `README.md` — Dedicated low-privilege SSH user setup as best practice

### Fixed
- `accessory.ts` — `isWolWindowActive()` helper replaces scattered `activeWolGeneration` cleanup
- `platform.ts` — Auth field validation in `discoverDevices()`
- `config.schema.json` — `uuidOverride` enforces `minLength: 1`
- `ssh.ts` — `exec()` error includes command name and stderr/stdout; `EHOSTDOWN`/`ENETUNREACH` documented

---

## [0.1.6] - 2026-06-04

### Fixed
- `accessory.ts` — `isPolling` reset in `destroy()`; `consecutiveFailures` reset moved to WOL path only; WOL verify uses retry count not wall clock; WOL verify timers `.unref()`'d; `handleShutdown()` destroyed guard; `schedulePoll()` destroyed guard; timer `.unref()`s; `revertState` no longer resets `consecutiveFailures`
- `wol.ts` — `socket 'error'` routes through `done()`
- `ssh.ts` — `ENETUNREACH` added to resolve-false list; known hosts format documented; OMV reference removed

---

## [0.1.5] - 2026-06-04

### Added
- `CHANGELOG.md` added to repository and included in npm package

---

## [0.1.4] - 2026-06-02

### Fixed
- `ssh.ts` — no-op `.catch()` on `execCommand` promise
- `wol.ts` — `settled` flag prevents double resolution
- `config.schema.json` — `maximum` constraints removed from all numeric fields (sliders → text inputs)

---

## [0.1.3] - 2026-06-02

### Added
- macOS support documented

### Fixed
- `platform.ts` — devices validated before UUID generation; `Record<string, unknown>` cast for dual-auth runtime check

---

## [0.1.2] - 2026-06-01

### Changed
- Removed all OpenMediaVault-specific references; plugin now platform-agnostic

---

## [0.1.1] - 2026-05-31

### Fixed
- `platform.ts` — malformed config no longer crashes with TypeError; UUID coercion; template literal log calls
- `accessory.ts` — `activeWolGeneration` cleared on shutdown toggle; WOL sends all 3 packets regardless of individual failures

---

## [0.1.0] - 2026-05-31

### Initial release

- HomeKit switch to wake a NAS via Wake-on-LAN and shut it down via SSH
- SSH TOFU host key verification with persistent fingerprint storage
- TCP port polling with exponential backoff up to 5 minutes
- Serialized state queue, generation counter, WOL retry loop
- Shutdown cooldown, optimistic UI updates with revert on failure
- Multi-device support, stale accessory cleanup, duplicate UUID detection
