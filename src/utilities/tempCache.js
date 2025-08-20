// tempCache.js
const cache = new Map();
const TTL = 1000 * 60 * 5; // 5 minutes

function set(key, value, ttl = TTL) {
    cache.set(key, { value, expiresAt: Date.now() + ttl });
}

function get(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        cache.delete(key);
        return null;
    }
    return entry.value;
}

function deleteKey(key) {
    cache.delete(key);
}

function cleanup() {
    const now = Date.now();
    for (const [key, entry] of cache.entries()) {
        if (entry.expiresAt <= now) {
            cache.delete(key);
        }
    }
}

// Run cleanup every minute
setInterval(cleanup, 60 * 1000).unref();

const tempCache = { set, get, deleteKey };
export default tempCache;
