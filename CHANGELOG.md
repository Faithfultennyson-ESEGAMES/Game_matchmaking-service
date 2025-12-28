# Changelog

All notable changes to the `matchmaking-server` will be documented in this file.

## [Unreleased] - 2025-01-05

### Fixed
-   **Webhook Authentication:** Corrected HMAC signature verification to use the `X-Hub-Signature-256` header sent by the `game-server`. This resolves authentication failures for the `/session-closed` webhook.
-   **Webhook Payload Parsing:** Fixed a critical bug in the `/session-closed` handler that looked for `session_id` (snake_case) instead of the correct `sessionId` (camelCase) in the payload. This ensures active game sessions are now properly cleared.
-   **Redis TTL Calls:** Switched to `pExpire`/`pTTL` for Redis v4 compatibility.
-   **Matchmaking Atomicity:** Queue pops are now atomic (Lua script) to avoid double-matching across instances.

### Added
-   **Documentation:** Created a comprehensive `README.md` with detailed instructions for setup, configuration, environment variables, client integration, and API endpoint usage.
-   **Redis Backend:** Queue and session state now stored in Redis with TTL-based cleanup and ACL username support.
-   **Card Game Support:** Added card game modes (2–6) with per-game turn duration config.
-   **Rate Limit Enhancements:** Optional `deviceId` and `X-Forwarded-For` IP keying, plus rate reset on match-found.
-   **Outcome Payloads:** `session-ended` now includes per-player outcome (`win`/`loss`/`draw`).
-   **Integration Guide:** Added `INTEGRATION.md` for end-to-end client integration.
-   **Private Lobbies:** Added invite-only lobbies with admin start, custom per-lobby timers, and idle/empty expiry.
