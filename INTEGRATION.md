# Matchmaking Server Integration Guide

This document explains how to build a client/app that talks to the matchmaking server, how to route users into a game client, and how to handle lifecycle events.

---

## 1. Connection Basics

Use Socket.IO. The server supports WebSocket with polling fallback.

```javascript
import { io } from "socket.io-client";

const socket = io("https://your-matchmaking-host", {
  transports: ["websocket", "polling"],
  reconnection: true,
  auth: { token: supabaseJwt } // required when AUTH_REQUIRED=true
});
```

If `AUTH_REQUIRED=true` on the server, connections without a valid Supabase JWT are rejected.

### Required Player Fields
Every request must include:
- `playerId` (stable, unique user identifier)
- `playerName` (display name)

Optional but recommended:
- `deviceId` (stable per device, helps rate limiting and abuse protection)

---

## 2. Requesting a Match

```javascript
socket.emit("request-match", {
  playerId: "user-123",
  playerName: "Alice",
  gameType: "card",      // "dice" | "tictactoe" | "card"
  mode: 4,               // dice: 2/4/6/15, card: 2-6, tictactoe always 2
  deviceId: "device-abc" // optional
});
```

### Game Type / Mode Rules
- Dice modes: `2`, `4`, `6`, `15`
- Card modes: `2`, `3`, `4`, `5`, `6`
- TicTacToe mode is always `2` (mode is optional and forced to 2)

If the queue reaches the required number of players, the server creates a session and emits `match-found` to each player.

---

## 3. Handling Server Events

### `match-found`
Payload:
```json
{
  "sessionId": "uuid",
  "joinUrl": "http://game-server/session/<id>/join",
  "gameType": "card",
  "mode": 4,
  "voiceChannel": "session_<id>"
}
```

Your app should now open the game client. For this repo’s game clients, the URL format is:

```
http://<game-client-host>/index.html?joinurl=<joinUrl>&playerId=<playerId>&playerName=<playerName>
```

Example:
```javascript
socket.on("match-found", (data) => {
  const url = new URL("https://your-card-client/index.html");
  url.searchParams.set("joinurl", data.joinUrl);
  url.searchParams.set("playerId", playerId);
  url.searchParams.set("playerName", playerName);
  window.location.href = url.toString();
});
```
`voiceChannel` is included for voice chat on public matches. Private lobbies provide `voiceChannel` on lobby snapshots (`lobby_<lobbyId>`), so `match-found` may omit it for lobby-started games.

### `match-error`
The server sends this when input is invalid, cooldown is active, or session creation fails.

```javascript
socket.on("match-error", (err) => {
  console.error(err.message);
  if (err.cooldownUntil) {
    // disable queue UI until cooldownUntil
  }
});
```

### `queue-status`
Broadcast counts by game + mode:
```json
{
  "dice": { "2": 1, "4": 0, "6": 0, "15": 0 },
  "tictactoe": { "2": 0 },
  "card": { "2": 3, "3": 0, "4": 0, "5": 0, "6": 0 }
}
```

Use this to show queue occupancy in your UI.

### `session-ended`
Emitted when the game ends (from webhook). Includes player outcome.
```json
{
  "sessionId": "uuid",
  "gameType": "card",
  "outcome": "win"
}
```

Outcomes: `win`, `loss`, `draw`.

### `queue-cancelled`
Acknowledges a cancel request:
```json
{ "playerId": "user-123" }
```

### `session-cleared`
Emitted after a valid `report-invalid-session`.

---

## 4. Cancel / Retry / Invalid Session Flow

### Cancel Queue
```javascript
socket.emit("cancel-match", { playerId, deviceId });
```

### Report Invalid Session
If the game client fails to connect or the session is invalid, report it:
```javascript
socket.emit("report-invalid-session", {
  playerId,
  playerName,
  sessionId
});
```

The server will clear the active session entry and emit `session-cleared`.

---

## 5. Rate Limit Behavior

To prevent join/cancel spam:
- Each `request-match` and `cancel-match` counts toward a rolling window.
- Keys include `playerId`, IP (from `X-Forwarded-For`), optional `deviceId`, and a combined key.
- After `MAX_CANCEL_JOIN` actions within `CANCEL_JOIN_WINDOW_MS`, the server responds with a cooldown.
- On successful `match-found`, rate limits reset for that player/IP/device.

Client UX should handle `cooldownUntil` to disable queue buttons.

---

## 6. Private Lobby Flow

Private lobbies are invite-only and never auto-fill from the public queue. The creator is the admin and must start the match.
Players in a private lobby cannot join the public queue until they leave the lobby.

Config rules:
- Dice: `{ playerCount, turnTimeMs }`
- TicTacToe: `{ turnDurationSec }` (playerCount is always 2)
- Card: `{ playerCount, turnDurationSec }`

### Create Lobby

```javascript
socket.emit("create-private-lobby", {
  playerId: "user-123",
  playerName: "Alice",
  gameType: "dice",
  config: {
    playerCount: 4,
    turnTimeMs: 8000
  },
  deviceId: "device-abc"
});
```

### Join Lobby

```javascript
socket.emit("join-private-lobby", {
  lobbyId: "lobby-uuid",
  playerId: "user-456",
  playerName: "Bob",
  deviceId: "device-xyz",
  config: {
    playerCount: 4,
    turnDurationSec: 12
  }
});
```

If `config` is provided on join, it must match the lobby’s stored config.

### Start Lobby (Admin only)

```javascript
socket.emit("start-private-lobby", { lobbyId: "lobby-uuid", playerId: "user-123" });
```

### Leave / Kick

```javascript
socket.emit("leave-private-lobby", { lobbyId, playerId });
socket.emit("kick-private-lobby", { lobbyId, playerId, targetPlayerId });
```

### Lobby Events

- `private-lobby-created` → lobby snapshot (creator)
- `private-lobby-joined` → lobby snapshot (joiner)
- `private-lobby-updated` → broadcast to lobby room
- `private-lobby-left` → acknowledgement for leaver
- `private-lobby-kicked` → target removed
- `private-lobby-closed` → lobby expired (idle/empty)

Lobby snapshots include `voiceChannel` for the lobby (e.g. `lobby_<lobbyId>`).

Idle timers pause while a lobby is in an active game, and resume after the game ends.
Players can still join a lobby while it is in a game as long as the lobby is not full; they will wait for the next start.

---

## 7. Security Notes

- The matchmaking server validates webhooks from game servers using `X-Hub-Signature-256` and `HMAC_SECRET`.
- Client apps do not call `/session-closed`; this is server-to-server only.
- If you are behind a proxy (Railway/NGINX), ensure `X-Forwarded-For` is set so IP rate limiting is accurate.

---

## 7. Redis State & TTLs (Operational)

The server stores queue + active session state in Redis:
- Queue entries: `DB_ENTRY_TTL_MS`
- Active sessions: `ACTIVE_GAMES_TTL_MS`
- Ended session markers: `DB_ENTRY_TTL_MS`

If the server crashes, stale entries expire automatically via TTL.

---

## 8. Minimal Test Checklist

1) Connect 2 players to dice mode 2 → expect `match-found`.
2) Connect 2 players to tictactoe → expect `match-found`.
3) Connect 2–6 players to card mode → expect `match-found`.
4) Finish a game → expect `session-ended` with `outcome`.
5) Trigger cooldown by spamming join/cancel → expect `match-error` with `cooldownUntil`.
