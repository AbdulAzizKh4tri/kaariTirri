// index.js
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const game = require('./game');
const helpers = require('./helpers');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = 3000;

// In-memory room storage: { roomId: { messages: [], gameState: {...} } }
const roomData = {};
const nameToSocket = {};

app.use(express.static(path.resolve('./public')));

io.on('connection', (socket) => {
    socket.on('joinRoom', (data) => {
        const { roomId, name } = data || {};
        if (!roomId || !name) return socket.emit('message', 'Missing roomId or name');

        socket.join(roomId);
        socket.roomId = roomId;
        socket.name = name;
        nameToSocket[name] = socket.id;

        // ensure room
        if (!roomData[roomId]) roomData[roomId] = { messages: [] };

        const gs = roomData[roomId].gameState;

        // If a game exists and this player is part of it, send private state
        if (gs) {
            if (gs.playerGameStates && gs.playerGameStates[socket.name]) {
                socket.emit('gameStateUpdate', { public: gs.public, playerGameState: gs.playerGameStates[socket.name] });
                socket.emit('gameStarted');
                return;
            }
            // game in progress but player not part of it -> allow chat only
            socket.emit('message', 'Game already in progress in this room. You can watch chat.');
        }

        // replay chat
        roomData[roomId].messages.forEach(m => socket.emit('message', m));

        helpers.sendToRoom(io, roomData, roomId, `User ${socket.name} joined the room`);
        console.log(`User ${socket.name} joined ${roomId}`);
    });

    socket.on('message', (msg) => {
        const roomId = socket.roomId;
        if (!roomId) return;
        helpers.sendToRoom(io, roomData, roomId, `${socket.name}: ${msg}`);
    });

    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        if (!roomId) return;
        io.to(roomId).emit('message', `${socket.name} disconnected`);
        helpers.clearRoomIfEmpty(io, roomData, roomId);
    });

    socket.on('gameStart', () => {
        const roomId = socket.roomId;
        if (!roomId) return socket.emit('message', 'Not in a room');

        // gather players from room sockets
        const room = io.sockets.adapter.rooms.get(roomId) || new Set();
        const players = [...room].map(id => {
            const s = io.sockets.sockets.get(id);
            return s && s.name ? { id, name: s.name } : null;
        }).filter(Boolean);

        if (players.length < 4) return socket.emit('message', 'Need at least 4 players to start');
        if (roomData[roomId].gameState) return socket.emit('message', 'Game already in progress');

        const socketMap = Object.fromEntries(players.map(p => [p.name, p.id]));
        const gameState = game.initialGameState(players);
        gameState.socketMap = socketMap;
        roomData[roomId].gameState = gameState;

        helpers.sendToRoom(io, roomData, roomId, `Game started by ${socket.name}`);

        // send all players their private + public state
        helpers.syncGameState(io, roomId, gameState);

        const bidder = game.getCurrentBidder(gameState);
        helpers.sendToRoom(io, roomData, roomId, `${bidder}'s turn to bid`);
        io.to(roomId).emit('gameStarted');
    });

    socket.on('bidPlaced', (bidAmount) => {
        const roomId = socket.roomId;
        if (!roomId) return;
        const gs = roomData[roomId] && roomData[roomId].gameState;
        if (!gs) return socket.emit('message', 'No ongoing game in this room.');
        if (gs.public.stage !== 'auction') return socket.emit('message', 'Auction is not active');

        const result = game.placeBid(gs, socket.name, bidAmount);
        // result: { status, messages: [], auctionWon: bool }
        result.messages.forEach(m => helpers.sendToRoom(io, roomData, roomId, m));
        helpers.syncGameState(io, roomId, gs);


        if (!result.auctionWon && gs.public.bidders.length > 0) {
            const next = game.getCurrentBidder(gs);
            helpers.sendToRoom(io, roomData, roomId, `${next}'s turn to bid`);
        }

        if(result.auctionWon){
            io.to(nameToSocket[gs.public.highestBidder]).emit('auctionWinner');
            io.to(roomId).emit('auctionWon', gs.public.highestBidder)
        }
    });

    socket.on('powerSuitSelected', (selectedSuit)=>{
        const roomId = socket.roomId;
        if(!roomId) return;

        const gs = roomData[roomId] && roomData[roomId].gameState;
        if (!gs) return socket.emit('message', 'No ongoing game in this room.');
        if(gs.public.stage !== 'powerSuitSelection') return socket.emit('message','Wrong game stage')

        const result = game.selectPowerSuit(gs, socket.name,selectedSuit);
        result.messages.forEach(m => helpers.sendToRoom(io, roomData, roomId, m));

        io.to(nameToSocket[socket.name]).emit('powerSuitSelected', result.data)
        helpers.syncGameState(io, roomId, gs);
    });

    socket.on('partnersSelected', (cards)=>{
        const roomId = socket.roomId;
        if(!roomId) return;

        const gs = roomData[roomId] && roomData[roomId].gameState;
        if (!gs) return socket.emit('message', 'No ongoing game in this room.');
        if(gs.public.stage !== 'partnerSelection') return socket.emit('message','Wrong game stage')

        const result = game.selectPartners(gs, socket.name, cards);
        result.messages.forEach(m => helpers.sendToRoom(io, roomData, roomId, m));

        io.to(roomId).emit('newRound')
        io.to(roomId).emit('message',`${socket.name}'s turn!`)
        helpers.syncGameState(io, roomId, gs);

        io.to(nameToSocket[socket.name]).emit('playerTurn');
    });

    socket.on('cardPlayed', (card)=>{
        const roomId = socket.roomId
        if(!roomId) return;

        const gs = roomData[roomId] && roomData[roomId].gameState;
        if (!gs) return socket.emit('message', 'No ongoing game in this room.');
        if(gs.public.stage !== 'playing') return socket.emit('message','Wrong game stage')

        const result = game.playCard(gs, socket.name, card);
        result.messages.forEach(m => helpers.sendToRoom(io, roomData, roomId, m));

        io.to(roomId).emit('cardPlayed', {playerName: socket.name, card})
        if(gs.public.round.length == 0){
            io.to(roomId).emit('newRound')
        }

        helpers.syncGameState(io, roomId, gs);
        if(gs.public.gameWinners){
            io.to(roomId).emit('gameOver')
        }else{   
            io.to(roomId).emit('message',`${gs.public.players[gs.public.turnIndex]}'s turn!`)
            io.to(nameToSocket[gs.public.players[gs.public.turnIndex]]).emit('playerTurn', gs.public.round[0]?.card?.suit);
        }


    })

});

app.get('/', (req, res) => {
    res.sendFile(path.resolve('./public/index.html'));
});

server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
