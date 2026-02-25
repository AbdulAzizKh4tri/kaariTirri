require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const game = require('./game');
const helpers = require('./helpers');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL,
	methods: ["GET", "POST"],
  }
});
const port = process.env.PORT || 3000;

// In-memory room storage: { roomId: { messages: [], gameState: {...} } }
// - Stores chat logs and game state for each room.
// - socketMap may be added dynamically to map playerName -> socketId.
const roomData = {};

io.on('connection', (socket) => {

    socket.on('joinRoom', (data) => {
        const { roomId, name } = data || {};
        if (!roomId || !name) return socket.emit('message', 'Missing roomId or name');

        socket.join(roomId);
        socket.roomId = roomId;
        socket.name = name;

        if (!roomData[roomId]) roomData[roomId] = { messages: [], chat: [] };

        roomData[roomId].socketMap = roomData[roomId].socketMap || {};
        roomData[roomId].socketMap[name] = socket.id;


        socket.emit('bulkMessage',roomData[roomId].messages);
        socket.emit('chatHistory',roomData[roomId].chat);

		io.to(roomId).emit('memberList', Object.keys(roomData[roomId].socketMap));

        helpers.sendToRoom(io, roomData, roomId, `User ${socket.name} joined the room`);
        console.log(`User ${socket.name} joined ${roomId}`);

        const gs = helpers.getGameState(roomData, roomId);

        if (gs) {

			if (gs.socketMap) gs.socketMap[name] = socket.id;

            if (gs.playerGameStates && gs.playerGameStates[socket.name]) {
                socket.emit('gameStateUpdate', { public: gs.public, playerGameState: gs.playerGameStates[socket.name] });
                if(socket.name == gs.public.players[gs.public.turnIndex]){
                    socket.emit('playerTurn');
                }
                return;
            }
            socket.emit('message', 'Game already in progress in this room. You can watch chat.');
        }


    });

    socket.on('userMessage', (msg) => {
        const roomId = socket.roomId;
        if (!roomId || !msg.trim()) return;
        helpers.sendUserMessage(io, roomData, roomId, {"name":socket.name, "message": msg.trim()});
    });


    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        if (!roomId) return;
        delete roomData[roomId].socketMap[socket.name];
        helpers.sendToRoom(io, roomData, roomId, `User ${socket.name} disconnected`);
		io.to(roomId).emit('playerList', Object.keys(roomData[roomId].socketMap));
        helpers.clearRoomIfEmpty(io, roomData, roomId);
    });

    socket.on('gameStart', () => {
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
    });


    socket.on('bidPlaced', (bidAmount) => {
        const roomId = socket.roomId;
        const gs = helpers.getGameState(roomData, roomId);
        if(!helpers.validateRoomAndGameStage(socket, roomId, gs, 'auction')) return

        const result = game.placeBid(gs, socket.name, bidAmount);

        if(result.status === 'wrongTurn'){
            return socket.emit('message', result.messages[0]);
        }

        helpers.bulkSendToRoom(io, roomData, roomId, result.messages);
        helpers.syncGameState(io, roomId, gs);

        if (!result.auctionWon && gs.public.bidders.length > 0) {
            const next = game.getCurrentBidder(gs);
            helpers.sendToRoom(io, roomData, roomId, `${next}'s turn to bid`);
        }
    });

    socket.on('powerSuitSelected', (selectedSuit)=>{
        const roomId = socket.roomId;
        const gs = helpers.getGameState(roomData, roomId);
        if(!helpers.validateRoomAndGameStage(socket, roomId, gs, 'powerSuitSelection')) return

        const result = game.selectPowerSuit(gs, socket.name,selectedSuit);
        helpers.bulkSendToRoom(io, roomData, roomId, result.messages);

        helpers.syncGameState(io, roomId, gs);
    });

    socket.on('partnersSelected', (cards)=>{

        const roomId = socket.roomId;
        const gs = helpers.getGameState(roomData, roomId);
        if(!helpers.validateRoomAndGameStage(socket, roomId, gs, 'partnerSelection')) return

        const result = game.selectPartners(gs, socket.name, cards);

        if(result.status === 'error'){
            return socket.emit('message', result.messages[0]);
        }

        helpers.bulkSendToRoom(io, roomData, roomId, result.messages);

        helpers.syncGameState(io, roomId, gs);
        helpers.announcePlayerTurn(io, roomData, roomId, gs);

    });


    socket.on('cardPlayed', (card)=>{
        const roomId = socket.roomId
        const gs = helpers.getGameState(roomData, roomId);
        if(!helpers.validateRoomAndGameStage(socket, roomId, gs, 'playing')) return

        const result = game.playCard(gs, socket.name, card);
        if(result.status === 'error'){
            return socket.emit('message', result.messages[0]);
        }
        helpers.bulkSendToRoom(io, roomData, roomId, result.messages);
        helpers.syncGameState(io, roomId, gs);

        io.to(roomId).emit('cardPlayed', {playerName: socket.name, card})
        if(gs.public.stage === 'playing'){
            helpers.announcePlayerTurn(io, roomData, roomId, gs)
        }
    });

});


// ------------------------------------------------------------
// Start server
// ------------------------------------------------------------
server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
