// helpers.js
function createRoomIfMissing(roomData, roomId) {
    if (!roomData[roomId]) roomData[roomId] = { messages: [] };
}

function sendToRoom(io, roomData, roomId, msg) {
    createRoomIfMissing(roomData, roomId);
    roomData[roomId].messages.push(msg);
    io.to(roomId).emit('message', msg);
}

function bulkSendToRoom(io, roomData, roomId, msgs) {
    createRoomIfMissing(roomData, roomId);
    roomData[roomId].messages.push(...msgs);
    io.to(roomId).emit('bulkMessage', msgs);
}

function syncGameState(io, roomId, gameState) {
    if (!gameState) return;
    const pub = gameState.public || {};
    const pg = gameState.playerGameStates || {};
    const map = gameState.socketMap || {};

    // private state to each player
    for (const [playerName, playerState] of Object.entries(pg)) {
        const socketId = map[playerName];
        if (!socketId) continue;
        const sock = io.sockets.sockets.get(socketId);
        if (sock) sock.emit('gameStateUpdate', { public: pub, playerGameState: playerState });
    }
}

function clearRoomIfEmpty(io, roomData, roomId) {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room || room.size === 0) {
        console.log(`Room ${roomId} is empty → clearing room data`);
        delete roomData[roomId];
    }
}

function removeCardFromHand(hand, suit, number) {
    const idx = hand.findIndex(
        card => card.suit === suit && card.number === number
    );

    if (idx !== -1) {
		card = hand[idx]
        hand.splice(idx, 1);   // removes the card
        return card;           // returns the removed card 
    }
    return null;              // card not found
}

function validateRoomAndGameStage(socket, roomId, gs, expectedStage) {
    if(!roomId) return false;
    if (!gs){
        socket.emit('message', 'No ongoing game in this room.');
        return false;
    }
    if(gs.public.stage !== expectedStage) {
        socket.emit('message','Wrong game stage')
        return false;
    }
    return true
}

function getGameState(roomData, roomId) {
    if (!roomId) return null;
    return roomData[roomId]?.gameState;
}

function announcePlayerTurn(io, roomData, roomId, gameState) {
    const currentPlayer = gameState.public.players[gameState.public.turnIndex];
    sendToRoom(io, roomData, roomId, `It's ${currentPlayer}'s turn!`);
}

module.exports = {
    createRoomIfMissing,
    sendToRoom,
    bulkSendToRoom,
    syncGameState,
    clearRoomIfEmpty,
    removeCardFromHand,
    validateRoomAndGameStage,
    getGameState,
    announcePlayerTurn
};
