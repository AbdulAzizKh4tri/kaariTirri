require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const game = require('./game');
const helpers = require('./helpers');
const redisStore = require('./redisClient');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  }
});

console.log('CLIENT_URL:', process.env.CLIENT_URL);
const port = process.env.PORT || 3000;

// In-memory cache of rooms for the current server session.
// On join, if a room isn't cached here we attempt to load it from Redis.
// After every mutation we persist back to Redis.
// socketMap is session-specific (socket IDs change on reconnect) so it is
// always rebuilt from the live sockets; stale IDs from Redis are harmless
// because they get overwritten immediately in the joinRoom handler.
const roomData = {};

// ─── Persistence helpers ───────────────────────────────────────────────────

/** Save the current in-memory state for a room to Redis. */
async function persist(roomId) {
    if (roomData[roomId]) {
        await redisStore.setRoom(roomId, roomData[roomId]);
    }
}

/**
 * Ensure roomData[roomId] is populated.
 * If it isn't in memory yet, try to restore it from Redis first.
 */
async function ensureRoom(roomId) {
    if (!roomData[roomId]) {
        const stored = await redisStore.getRoom(roomId);
        if (stored) {
            roomData[roomId] = stored;
            console.log(`Room ${roomId} restored from Redis`);
        } else {
            roomData[roomId] = { messages: [], chat: [], gameResults: [] };
        }
    }
}

// ─── Socket.io ────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

    socket.on('joinRoom', async (data) => {
        const { roomId, name } = data || {};
        if (!roomId || !name) return socket.emit('message', 'Missing roomId or name');

        // Restore from Redis if this room isn't in memory yet
        await ensureRoom(roomId);

        // Reject if the name is already taken by a currently connected socket
        const existingSocketId = roomData[roomId].socketMap?.[name];
        if (existingSocketId && io.sockets.sockets.get(existingSocketId)) {
            return socket.emit('message', `Name "${name}" is already taken in this room.`);
        }

        socket.join(roomId);
        socket.roomId = roomId;
        socket.name = name;

        roomData[roomId].socketMap = roomData[roomId].socketMap || {};
        roomData[roomId].socketMap[name] = socket.id;

        socket.emit('bulkMessage', roomData[roomId].messages);
        socket.emit('chatHistory', roomData[roomId].chat);

        io.to(roomId).emit('memberList', Object.keys(roomData[roomId].socketMap));

        helpers.sendToRoom(io, roomData, roomId, `User ${socket.name} joined the room`);
        console.log(`User ${socket.name} joined ${roomId}`);

        const gs = helpers.getGameState(roomData, roomId);

        if (gs) {
            // Always keep gameState's socketMap in sync with live session
            if (gs.socketMap) gs.socketMap[name] = socket.id;

            if (gs.playerGameStates && gs.playerGameStates[socket.name]) {
                socket.emit('gameStateUpdate', {
                    public: gs.public,
                    playerGameState: gs.playerGameStates[socket.name]
                });
                if (socket.name === gs.public.players[gs.public.turnIndex]) {
                    socket.emit('playerTurn');
                }
                await persist(roomId);
                return;
            }
            socket.emit('message', 'Game already in progress in this room. You can watch chat.');
        }

        await persist(roomId);
    });

    // ── Chat ──────────────────────────────────────────────────────────────

    socket.on('userMessage', async (msg) => {
        const roomId = socket.roomId;
        if (!roomId || !msg.trim()) return;
        helpers.sendUserMessage(io, roomData, roomId, { name: socket.name, message: msg.trim() });
        await persist(roomId);
    });

    // ── Disconnect ────────────────────────────────────────────────────────

    socket.on('disconnect', async () => {
        const roomId = socket.roomId;
        if (!roomId || !roomData[roomId]) return;

        delete roomData[roomId].socketMap[socket.name];
        helpers.sendToRoom(io, roomData, roomId, `User ${socket.name} disconnected`);
        io.to(roomId).emit('memberList', Object.keys(roomData[roomId].socketMap));

        // Clear in-memory cache immediately if the room is empty.
        // Redis is intentionally left untouched — it will expire on its own TTL,
        // so a player who reconnects before then can still restore their session.
        // If you ever want eager Redis cleanup, add: await redisStore.deleteRoom(roomId)
        const wasCleared = helpers.clearRoomIfEmpty(io, roomData, roomId);

        // If the room still has members, persist the updated socketMap
        if (!wasCleared) await persist(roomId);
    });

    // ── Game start ────────────────────────────────────────────────────────

    socket.on('gameStart', async () => {
        const roomId = socket.roomId;
        if (!roomId) return socket.emit('message', 'Not in a room');

        const room = io.sockets.adapter.rooms.get(roomId) || new Set();
        const players = [...room].map(id => {
            const s = io.sockets.sockets.get(id);
            return s && s.name ? { id, name: s.name } : null;
        }).filter(Boolean);

        if (players.length < 4) return socket.emit('message', 'Need at least 4 players to start');

        const socketMap = Object.fromEntries(players.map(p => [p.name, p.id]));
        const gameState = game.initialGameState(players);
        gameState.socketMap = socketMap;
        roomData[roomId].gameState = gameState;

        helpers.sendToRoom(io, roomData, roomId, `Game started by ${socket.name}`);
        helpers.syncGameState(io, roomId, gameState);

        const bidder = game.getCurrentBidder(gameState);
        helpers.sendToRoom(io, roomData, roomId, `${bidder}'s turn to bid`);

        await persist(roomId);
    });

    // ── Auction ───────────────────────────────────────────────────────────

    socket.on('bidPlaced', async (bidAmount) => {
        const roomId = socket.roomId;
        const gs = helpers.getGameState(roomData, roomId);
        if (!helpers.validateRoomAndGameStage(socket, roomId, gs, 'auction')) return;

        const result = game.placeBid(gs, socket.name, bidAmount);

        if (result.status === 'wrongTurn') {
            return socket.emit('message', result.messages[0]);
        }

        helpers.bulkSendToRoom(io, roomData, roomId, result.messages);
        helpers.syncGameState(io, roomId, gs);

        if (!result.auctionWon && gs.public.bidders.length > 0) {
            const next = game.getCurrentBidder(gs);
            helpers.sendToRoom(io, roomData, roomId, `${next}'s turn to bid`);
        }

        await persist(roomId);
    });

    // ── Power suit selection ───────────────────────────────────────────────

    socket.on('powerSuitSelected', async (selectedSuit) => {
        const roomId = socket.roomId;
        const gs = helpers.getGameState(roomData, roomId);
        if (!helpers.validateRoomAndGameStage(socket, roomId, gs, 'powerSuitSelection')) return;

        const result = game.selectPowerSuit(gs, socket.name, selectedSuit);
        helpers.bulkSendToRoom(io, roomData, roomId, result.messages);
        helpers.syncGameState(io, roomId, gs);

        await persist(roomId);
    });

    // ── Partner selection ─────────────────────────────────────────────────

    socket.on('partnersSelected', async (cards) => {
        const roomId = socket.roomId;
        const gs = helpers.getGameState(roomData, roomId);
        if (!helpers.validateRoomAndGameStage(socket, roomId, gs, 'partnerSelection')) return;

        const result = game.selectPartners(gs, socket.name, cards);

        if (result.status === 'error') {
            return socket.emit('message', result.messages[0]);
        }

        helpers.bulkSendToRoom(io, roomData, roomId, result.messages);
        helpers.syncGameState(io, roomId, gs);
        helpers.announcePlayerTurn(io, roomData, roomId, gs);

        await persist(roomId);
    });

    // ── Card played ───────────────────────────────────────────────────────

    socket.on('cardPlayed', async (card) => {
        const roomId = socket.roomId;
        const gs = helpers.getGameState(roomData, roomId);
        if (!helpers.validateRoomAndGameStage(socket, roomId, gs, 'playing')) return;

        const result = game.playCard(gs, socket.name, card);
        if (result.status === 'error') {
            return socket.emit('message', result.messages[0]);
        }

        helpers.bulkSendToRoom(io, roomData, roomId, result.messages);
        helpers.syncGameState(io, roomId, gs);

        io.to(roomId).emit('cardPlayed', { playerName: socket.name, card });

        if (gs.public.stage === 'gameOver') {
            roomData[roomId].gameResults = roomData[roomId].gameResults || [];
            roomData[roomId].gameResults.push({
                highestBid: gs.public.highestBid,
                highestBidder: gs.public.highestBidder,
                gameWinners: gs.public.gameWinners,
				gameLosers: gs.public.players.filter(p => !gs.public.gameWinners.includes(p))
            });
        }

        if (gs.public.stage === 'playing') {
            helpers.announcePlayerTurn(io, roomData, roomId, gs);
        }

        await persist(roomId);
    });

});

// ─── Start server ──────────────────────────────────────────────────────────

server.listen(port, '0.0.0.0', () => {
    console.log(`Server running at ${port}`);
});
