const Redis = require('ioredis');

// Easily change room TTL here — value is in hours
const ROOM_TTL_HOURS = parseInt(process.env.ROOM_TTL_HOURS || '2', 10);
const ROOM_TTL_SECONDS = ROOM_TTL_HOURS * 3600;

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    // ioredis will automatically retry on disconnect
    maxRetriesPerRequest: 3,
});

redis.on('connect', () => console.log('Redis connected'));
redis.on('error', (err) => console.error('Redis error:', err));

/**
 * Serialize roomData for Redis storage.
 * Converts Set objects (alpha, beta) to plain arrays so JSON.stringify works.
 */
function serialize(roomData) {
    if (!roomData) return null;

    // shallow clone so we don't mutate the live in-memory object
    const data = { ...roomData };

    if (data.gameState) {
        const gs = { ...data.gameState };

        if (gs.alpha instanceof Set) gs.alpha = [...gs.alpha];
        if (gs.beta instanceof Set) gs.beta = [...gs.beta];

        // playerGameStates hands are plain arrays — fine as-is
        data.gameState = gs;
    }

    return JSON.stringify(data);
}

/**
 * Deserialize roomData from Redis.
 * Reconstructs Set objects (alpha, beta) from the stored arrays.
 */
function deserialize(json) {
    if (!json) return null;

    const data = JSON.parse(json);

    if (data.gameState) {
        const gs = data.gameState;

        // Reconstruct Sets — Set deduplicates, so this is safe even if the
        // source array somehow had duplicates (it won't, but just to be explicit)
        if (Array.isArray(gs.alpha)) gs.alpha = new Set(gs.alpha);
        if (Array.isArray(gs.beta))  gs.beta  = new Set(gs.beta);
    }

    return data;
}

/**
 * Load a room from Redis.
 * Returns the deserialized room object, or null if it doesn't exist.
 */
async function getRoom(roomId) {
    try {
        const json = await redis.get(`room:${roomId}`);
        return deserialize(json);
    } catch (err) {
        console.error(`Redis getRoom error for ${roomId}:`, err);
        return null;
    }
}

/**
 * Persist a room to Redis with the configured TTL.
 * Call this after any mutation to roomData[roomId].
 */
async function setRoom(roomId, roomData) {
    try {
        const json = serialize(roomData);
        if (json) await redis.set(`room:${roomId}`, json, 'EX', ROOM_TTL_SECONDS);
    } catch (err) {
        console.error(`Redis setRoom error for ${roomId}:`, err);
    }
}

/**
 * Delete a room from Redis (called when the room empties).
 */
async function deleteRoom(roomId) {
    try {
        await redis.del(`room:${roomId}`);
    } catch (err) {
        console.error(`Redis deleteRoom error for ${roomId}:`, err);
    }
}

module.exports = { redis, getRoom, setRoom, deleteRoom };
