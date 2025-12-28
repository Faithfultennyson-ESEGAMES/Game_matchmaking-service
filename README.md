# Matchmaking Server for ESEGAMES

This Node.js application is the central matchmaking service for the ESEGAMES platform. It manages a player queue, forms matches, and communicates with the `game-server` to create game sessions. It stores queue and session state in Redis with TTL-based cleanup.

## High-Level Workflow

1.  **Client Connection**: A player connects to this server via Socket.IO.
2.  **Match Request**: The client emits a `request-match` event with `playerId`, `playerName`, `gameType`, and `mode` (plus optional `deviceId`).
3.  **Queuing**: The player is added to a queue. When the required number of players for that mode is present, a match is formed.
4.  **Session Creation**: The server sends a signed, server-to-server `POST` request to the appropriate game server (`dice`, `tictactoe`, or `card`) `/start` endpoint using the selected mode. For dice/card, the payload includes `playerCount`.
5.  **Receive Game Details**: The `game-server` responds with a `sessionId` and a `joinUrl`. This response is verified using a shared HMAC secret.
6.  **Notify Players**: The server emits a `match-found` event to both players, providing the `sessionId` and `joinUrl`.
7.  **Client Redirect**: The clients construct the final game URL using the received data and redirect the players to the game client.
8.  **Session Closure**: After the game ends, the `game-server` sends a `POST /session-closed` webhook back to this server.
9.  **State Cleanup**: This server validates the webhook, removes the players from the active games list, and emits a `session-ended` event to notify the clients (including win/loss/draw).

---

## Getting Started

### 1. Installation

Clone the repository and install the dependencies.

```bash
npm install
```

### 2. Configuration (`.env` file)

Create a `.env` file in the `matchmaking-server/` directory. This is essential for configuring the server.

```bash
# .env

# Port for the matchmaking server.
PORT=3330

# Dice game-server URL (e.g., http://localhost:3001).
DICE_GAME_SERVER_URL=http://localhost:3001

# TicTacToe game-server URL (e.g., http://localhost:5500).
TICTACTOE_GAME_SERVER_URL=http://localhost:5500

# Card game-server URL (e.g., http://localhost:3000).
CARD_GAME_SERVER_URL=http://localhost:3000

# The shared password for authenticating with the game-server's protected endpoints.
# This MUST match the DLQ_PASSWORD in the game-server's .env file.
DLQ_PASSWORD=your_strong_secret_password

# A shared secret for HMAC-SHA256 signature verification.
# This MUST match the HMAC_SECRET in the game-server's .env file.
HMAC_SECRET=your_very_strong_hmac_secret

# --- Redis settings (required) ---
# Provide either REDIS_URL, or REDIS_HOST + REDIS_PORT + credentials.
# If your Redis provider uses ACLs, set REDIS_USERNAME.
REDIS_HOST=redis-18324.c341.af-south-1-1.ec2.cloud.redislabs.com
REDIS_PORT=18324
REDIS_USERNAME=your_redis_username
REDIS_PASSWORD=your_redis_password
REDIS_USE_TLS=true

# --- Optional Settings ---
MAX_SESSION_CREATION_ATTEMPTS=3
SESSION_CREATION_RETRY_DELAY_MS=1500
DB_ENTRY_TTL_MS=3600000
ACTIVE_GAMES_TTL_MS=3600000

# --- Private Lobby Settings ---
PRIVATE_LOBBY_IDLE_MS=1800000
PRIVATE_LOBBY_EMPTY_GRACE_MS=60000

# --- Per-game Turn Timers ---
# Dice /start expects turnTimeMs
DICE_TURN_TIME_MS=8000

# TicTacToe /start expects turnDurationSec
TICTACTOE_TURN_DURATION_SEC=6

# Card /start expects turnDurationSec
CARD_TURN_DURATION_SEC=12

# --- Queue Cooldown (cancel/join spam protection) ---
CANCEL_JOIN_WINDOW_MS=300000
MAX_CANCEL_JOIN=8
COOLDOWN_MS=60000
```

### 3. Running the Server

```bash
node index.js
```


---

## Client Integration Guide

Clients must use Socket.IO to connect and interact with this server. For a deeper, app-focused walkthrough, see `matchmaking-server/INTEGRATION.md`.

### 1. Connect and Request a Match

```javascript
import { io } from "socket.io-client";

const socket = io("https://tictac-toematchmaking-service-production.up.railway.app"); // Your matchmaking server URL

const playerDetails = {
    playerId: 'user-12345-abcdef', // A unique, stable identifier
    playerName: 'RizzoTheRat',     // Display name
    gameType: 'dice',              // 'dice', 'tictactoe', or 'card'
    mode: 4,                       // dice: 2/4/6/15, card: 2-6, tictactoe always 2
    deviceId: 'device-uuid'        // Optional: per-device identifier for rate limiting
};

socket.emit('request-match', playerDetails);
```

Dice modes supported: `2`, `4`, `6`, `15`.
Card modes supported: `2`, `3`, `4`, `5`, `6`.
TicTacToe always uses mode `2` (mode is optional and forced to `2`).

When creating sessions:
- Dice: `{ playerCount: <mode>, turnTimeMs: DICE_TURN_TIME_MS }`
- TicTacToe: `{ turnDurationSec: TICTACTOE_TURN_DURATION_SEC }`
- Card: `{ playerCount: <mode>, turnDurationSec: CARD_TURN_DURATION_SEC }`

### Queue behavior and overflow

Queues are per game type and per mode. If more players are queued than needed (e.g., 7/4), the server will create one session using 4 players and leave the remaining players in the queue. It keeps matching as long as `queue.length >= requiredPlayers`.

### 2. Handle Server Responses

Your client must handle the primary server events.

**`match-found`**: The server has found a match and created a game session. The payload contains the necessary information to join.

```javascript
socket.on('match-found', (data) => {
    console.log('Match Found!', data);
    // data = { 
    //   sessionId: "d2c1ba68-ab40-46b5-9651-b48ed4cb8069",
    //   joinUrl: "http://game-server:5500/session/d2c1ba68-ab40-46b5-9651-b48ed4cb8069/join",
    //   gameType: "dice",
    //   mode: 4
    // }

    // IMPORTANT: Construct the URL for your game client, passing the details.
    const gameClientUrl = new URL('http://localhost:8080/index.html'); // URL to your game client
    gameClientUrl.searchParams.set('joinUrl', data.joinUrl);
    gameClientUrl.searchParams.set('playerId', playerDetails.playerId);
    gameClientUrl.searchParams.set('playerName', playerDetails.playerName);

    // Redirect the user to the game client.
    window.location.href = gameClientUrl.toString();
});
```

**`match-error`**: The server failed to create a game session or another error occurred (including cooldown blocks).

```javascript
socket.on('match-error', (error) => {
    console.error('Matchmaking Error:', error.message);
    // error = { message: "Could not create game session.", cooldownUntil?: 1698400000000 }
    // Display a "Try again" UI to the user.
});
```

If `cooldownUntil` is provided, the client should disable further queue requests until that timestamp.

The cooldown triggers after a player cancels/joins the queue more than `MAX_CANCEL_JOIN` times within `CANCEL_JOIN_WINDOW_MS`.

**`cancel-match`**: Client request to leave any queue (also used when switching modes).

```javascript
socket.emit('cancel-match', { playerId: 'user-12345-abcdef', deviceId: 'device-uuid' });
```

**`session-ended`**: The game has officially concluded. The user is now free to request a new match.

```javascript
socket.on('session-ended', (data) => {
    console.log(`Session ${data.sessionId} has ended (${data.outcome}).`);
    // data = { sessionId: "...", outcome: "win" | "loss" | "draw" }

    // Update the UI to allow the user to start a new match search.
});
```

**`queue-status`**: The server broadcasts queue counts by game and mode.

```javascript
socket.on('queue-status', (data) => {
    // data = { dice: { 2: 1, 4: 3, 6: 0, 15: 0 }, tictactoe: { 2: 2 }, card: { 2: 0, 3: 1, 4: 0, 5: 0, 6: 0 } }
});
```

**`queue-cancelled`**: The server confirmed the player left the queue.

```javascript
socket.on('queue-cancelled', (data) => {
    // data = { playerId: "user-12345-abcdef" }
});
```

### Error codes and reasons

`match-error` payloads always include a `message` and may include `cooldownUntil`.

Common errors:

- `Invalid gameType. Use dice, tictactoe, or card.` (unknown game type)
- `Invalid mode. Dice: 2,4,6,15. Card: 2-6.` (invalid mode)
- `playerId and playerName are required.` (missing required fields)
- `Cooldown active. Please wait before re-queueing.` (rate limit triggered)
- `Could not create game session.` (game server `/start` failed after retries)
- `Invalid session report. You are not in that session.` (bad `report-invalid-session`)

### Rate limit / cooldown policy

- Each `request-match` and `cancel-match` counts toward the same rolling window.
- Rate limiting keys include playerId, IP (from `X-Forwarded-For` when present), optional deviceId, and a combined key.
- If a player exceeds `MAX_CANCEL_JOIN` actions within `CANCEL_JOIN_WINDOW_MS`, the server blocks new queue requests until `COOLDOWN_MS` passes.
- During cooldown, the server responds with `match-error` and includes `cooldownUntil` (epoch ms).
- Once a match is found, the rate limit entries are reset for that player/IP/device combination.

### 3. Handling Invalid Sessions (Client-Side Recovery)

In rare cases, a client may be assigned to a session that is invalid (e.g., the game client fails to connect, or the session is already full or seems to be over). If a client cannot successfully join the game specified in `match-found`, it should report the session as invalid so the server can clear the active session entry. The client can then decide when to call `request-match` again.

**`report-invalid-session`**: Sent by the client to report a broken session and clear the active session entry.

```javascript
// Let's say you stored the sessionId from the 'match-found' event
const currentSessionId = "d2c1ba68-ab40-46b5-9651-b48ed4cb8069";

// If your game client determines this session is bad, report it.
const reportPayload = {
    playerId: 'user-12345-abcdef',
    playerName: 'RizzoTheRat',
    sessionId: currentSessionId
};

socket.emit('report-invalid-session', reportPayload);
```

**`session-cleared`**: The server confirms the report was valid and the player was removed from the active session.

```javascript
socket.on('session-cleared', () => {
    console.log('Server confirmed our report. You can request a new match.');
    // Update UI to show "Find Match" or "Play Again".
});
```

---

## Private Lobby Flow (Invite-Only)

Private lobbies are separate from the public queue and never auto-fill. A lobby is created with game rules, returns a lobby ID, and players join using that ID. The admin manually starts the match when the lobby is full and all players are connected.
Players can join a lobby while it is in a game as long as the lobby is not full; they will wait for the next start.
Players in a private lobby must leave it before joining the public queue.

Config rules:
- Dice: `{ playerCount, turnTimeMs }`
- TicTacToe: `{ turnDurationSec }`
- Card: `{ playerCount, turnDurationSec }`

Private lobbies close when idle for `PRIVATE_LOBBY_IDLE_MS`, or when empty for longer than `PRIVATE_LOBBY_EMPTY_GRACE_MS` (timers pause during active games).

### Create Private Lobby

```javascript
socket.emit('create-private-lobby', {
    playerId: 'user-12345-abcdef',
    playerName: 'Alice',
    gameType: 'card',
    config: {
        playerCount: 4,
        turnDurationSec: 12
    },
    deviceId: 'device-uuid'
});
```

Server responds with `private-lobby-created` and a full lobby snapshot.

### Join Private Lobby

```javascript
socket.emit('join-private-lobby', {
    lobbyId: 'lobby-uuid',
    playerId: 'user-2222',
    playerName: 'Bob',
    deviceId: 'device-xyz'
});
```

### Leave / Kick

```javascript
socket.emit('leave-private-lobby', { lobbyId, playerId });
socket.emit('kick-private-lobby', { lobbyId, playerId, targetPlayerId });
```

### Start Private Lobby (Admin Only)

```javascript
socket.emit('start-private-lobby', { lobbyId, playerId });
```

When the session is created, each lobby member receives `match-found` with `sessionId` + `joinUrl`.

### Lobby Events

- `private-lobby-created` → lobby snapshot (creator only)
- `private-lobby-joined` → lobby snapshot (joining player)
- `private-lobby-updated` → broadcast to lobby room
- `private-lobby-left` → acknowledgement for leaver
- `private-lobby-kicked` → target was removed
- `private-lobby-closed` → lobby expired/closed (idle or empty)

---

## Backend API Endpoints

The server exposes one HTTP endpoint for server-to-server communication.

### `POST /session-closed`

This endpoint is called by the `game-server` when a session ends.

*   **Method**: `POST`
*   **Security**: The caller **must** include an `X-Hub-Signature-256` header containing the HMAC-SHA256 signature of the raw request body, using the shared `HMAC_SECRET`.
*   **Request Body**: The full `session.ended` webhook payload from the game server. The matchmaking server will extract the `sessionId` from this object.

    ```json
    {
      "sessionId": "ccdb7fae-68a3-4dac-9e45-92d50299f471",
      "status": "ended",
      "players": [...],
      "board": [...],
      "winnerPlayerId": "p1",
      // ... and other session fields
    }
    ```
*   **Success Response**: `200 OK`
*   **Error Responses**:
    *   `400 Bad Request`: If `sessionId` is missing.
    *   `401 Unauthorized`: If the signature header is missing.
    *   `403 Forbidden`: If the signature is invalid.
