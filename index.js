require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const { JSONFile, Low } = require('lowdb');
const cors = require('cors');

// --- Configuration & Initialization ---

const PORT = process.env.PORT || 3330;
const MATCHMAKING_AUTH_TOKEN = process.env.MATCHMAKING_AUTH_TOKEN;
const MATCHMAKING_HMAC_SECRET = process.env.MATCHMAKING_HMAC_SECRET;
const GAME_SERVER_URL = process.env.GAME_SERVER_URL;
const DB_ENTRY_TTL_MS = parseInt(process.env.DB_ENTRY_TTL_MS, 10) || 3600000;
const MAX_SESSION_CREATION_ATTEMPTS = parseInt(process.env.MAX_SESSION_CREATION_ATTEMPTS, 10) || 3;
const SESSION_CREATION_RETRY_DELAY_MS = parseInt(process.env.SESSION_CREATION_RETRY_DELAY_MS, 10) || 1500;

if (!MATCHMAKING_AUTH_TOKEN || !MATCHMAKING_HMAC_SECRET) {
    console.error('FATAL ERROR: MATCHMAKING_AUTH_TOKEN and MATCHMAKING_HMAC_SECRET must be defined in .env file.');
    process.exit(1);
}

const app = express();
const server = http.createServer(app);

// --- Middleware ---

app.use(cors());

const saveRawBody = (req, res, buf, encoding) => {
    if (buf && buf.length) {
        req.rawBody = buf.toString(encoding || 'utf8');
    }
};
app.use(express.json({ verify: saveRawBody }));

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const verifyWebhookSignature = (req, res, next) => {
    const signature = req.headers['x-signature'];
    if (!signature) {
        console.error("[Webhook Error] Signature header missing. Expected \'x-signature\'.");
        return res.status(401).send("Signature header missing. Expected \'x-signature\'.");
    }
    
    if (!req.rawBody) {
        console.error('[Webhook Error] Raw body not available for signature verification.');
        return res.status(500).send('Internal Server Error: Raw body not saved.');
    }

    const expectedSignature = crypto.createHmac('sha256', MATCHMAKING_HMAC_SECRET).update(req.rawBody).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
        console.error('[Webhook Error] Invalid signature.');
        return res.status(403).send('Invalid signature.');
    }
    next();
};


// --- Database Setup ---

const adapter = new JSONFile('db.json');
const db = new Low(adapter);

async function initializeDatabase() {
    await db.read();
    db.data = db.data || {
        queue: [],
        active_games: {},
        ended_games: {}
    };
    await db.write();
}

// --- Helper Functions ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Main Application Logic ---

async function main() {
    await initializeDatabase();

    // --- HTTP ROUTES ---
    app.post('/session-closed', verifyWebhookSignature, async (req, res) => {
        const { sessionId } = req.body;
        console.log(`[Webhook] Received session-closed event for session: ${sessionId}`);

        if (!sessionId) {
            console.warn('[Webhook] Received session-closed event with no sessionId.');
            return res.status(400).send('Bad Request: sessionId is required.');
        }

        try {
            await db.read();

            const playerIdsInSession = Object.keys(db.data.active_games).filter(
                (playerId) => db.data.active_games[playerId].sessionId === sessionId
            );

            if (playerIdsInSession.length === 0) {
                console.log(`[Webhook] No active players found for session ${sessionId}. It might have already been cleared.`);
                return res.status(200).send('Session already cleared or unknown.');
            }

            console.log(`[State] Clearing active session ${sessionId} for players: ${playerIdsInSession.join(', ')}`);

            for (const playerId of playerIdsInSession) {
                // NEW: Notify the client that the session has ended using their persistent playerId room.
                console.log(`[Socket] Notifying player ${playerId} that session ${sessionId} has ended.`);
                io.to(playerId).emit('session-ended', { sessionId });
                delete db.data.active_games[playerId];
            }

            db.data.ended_games[sessionId] = { ended_at: new Date().toISOString() };

            await db.write();

            console.log(`[State] Session ${sessionId} successfully closed and moved to ended_games.`);
            res.status(200).send('Session successfully closed.');
        } catch (error) {
            console.error(`[FATAL] Error processing /session-closed for session ${sessionId}:`, error);
            res.status(500).send('Internal Server Error.');
        }
    });


    // --- SOCKET.IO LOGIC ---
    io.on('connection', (socket) => {
        console.log(`[Socket] Client connected: ${socket.id}`);

        socket.on('request-match', async (data) => {
            try {
                const { playerId, playerName } = data;
                if (!playerId) {
                    return socket.emit('match-error', { message: 'PlayerId is required.' });
                }
                console.log(`[Socket] Match requested by PlayerID: ${playerId}`);

                // NEW: Have the socket join a room identified by its playerId.
                // This allows us to message the player even if their socketId changes on reconnect.
                socket.join(playerId);

                await db.read();

                if (db.data.active_games[playerId]) {
                    const { sessionId, join_url } = db.data.active_games[playerId];
                    console.log(`[State] Player ${playerId} is already in a game. Resending session details.`);
                    return socket.emit('match-found', { sessionId, join_url });
                }

                if (!db.data.queue.some(p => p.playerId === playerId)) {
                    // Storing socket.id is still useful for temporary disconnect logic.
                    db.data.queue.push({ playerId, playerName, socketId: socket.id });
                    await db.write();
                    console.log(`[State] Player ${playerId} added to queue. Queue size: ${db.data.queue.length}`);
                }

                if (db.data.queue.length >= 2) {
                    const [player1, player2] = db.data.queue.splice(0, 2);
                    await db.write();
                    console.log(`[Match] Found a match between ${player1.playerId} and ${player2.playerId}.`);

                    for (let attempt = 1; attempt <= MAX_SESSION_CREATION_ATTEMPTS; attempt++) {
                        try {
                            console.log(`[Game Server] Attempt ${attempt} to create session for players: ${player1.playerId}, ${player2.playerId}`);
                            const response = await fetch(`${GAME_SERVER_URL}/start`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${MATCHMAKING_AUTH_TOKEN}`
                                }
                            });

                            if (!response.ok) {
                                throw new Error(`Game server returned status ${response.status}`);
                            }

                            const body = await response.json();
                            const { session_id, join_url } = body;
                            const receivedSignature = body.signature;

                            if (!receivedSignature) {
                                throw new Error('Response from game server is missing signature');
                            }

                            const payloadToVerify = { session_id, join_url };
                            const canonicalString = JSON.stringify(payloadToVerify);
                            const computedSignature = crypto.createHmac('sha256', MATCHMAKING_HMAC_SECRET).update(canonicalString).digest('hex');

                            if (!crypto.timingSafeEqual(Buffer.from(receivedSignature), Buffer.from(computedSignature))) {
                                throw new Error('Invalid response signature from game server');
                            }
                            
                            const sessionId = session_id;
                            console.log(`[Game Server] Successfully created and verified session ${sessionId}`);

                            db.data.active_games[player1.playerId] = { sessionId, join_url };
                            db.data.active_games[player2.playerId] = { sessionId, join_url };
                            await db.write();

                            // UPDATED: Emit to the playerId room for robustness.
                            io.to(player1.playerId).emit('match-found', { sessionId, join_url });
                            io.to(player2.playerId).emit('match-found', { sessionId, join_url });

                            break; // Success!

                        } catch (error) {
                            console.error(`[Error] Attempt ${attempt} failed:`, error.message);
                            if (attempt < MAX_SESSION_CREATION_ATTEMPTS) {
                                await delay(SESSION_CREATION_RETRY_DELAY_MS);
                            } else {
                                console.error('[Fatal] All attempts to create a game session failed.');
                                await db.read();
                                if (!db.data.queue.some(p => p.playerId === player1.playerId)) { db.data.queue.unshift(player1); }
                                if (!db.data.queue.some(p => p.playerId === player2.playerId)) { db.data.queue.unshift(player2); }
                                await db.write();

                                // UPDATED: Emit to rooms, not old socketIds.
                                io.to(player1.playerId)?.emit('match-error', { message: 'Could not create game session.' });
                                io.to(player2.playerId)?.emit('match-error', { message: 'Could not create game session.' });
                            }
                        }
                    }
                }
            } catch (err) {
                console.error('[FATAL] Unhandled error in request-match handler:', err);
                socket.emit('match-error', { message: 'An unexpected server error occurred.' });
            }
        });

        socket.on('disconnect', async () => {
            console.log(`[Socket] Client disconnected: ${socket.id}`);
            try {
                await db.read();
                const index = db.data.queue.findIndex(p => p.socketId === socket.id);
                if (index !== -1) {
                    const { playerId } = db.data.queue.splice(index, 1)[0];
                    console.log(`[State] Player ${playerId} removed from queue due to disconnect.`);
                    await db.write();
                }
            } catch (err) {
                console.error('[FATAL] Unhandled error in disconnect handler:', err);
            }
        });
    });

    server.listen(PORT, () => {
        console.log(`Matchmaking server listening on http://localhost:${PORT}`);
    });
}

main();
