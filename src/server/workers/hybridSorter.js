import { MinPriorityQueue } from '@datastructures-js/priority-queue';
import path from 'path';
import { fileURLToPath } from 'url';
import workerpool from 'workerpool';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Create a worker pool with 2–4 workers
const pool = workerpool.pool(path.resolve(__dirname, 'sortWorker.js'), {
    minWorkers: 2,
    maxWorkers: 4
});

const SORT_THRESHOLD = 50000;

function topKUpdates(results, k) {
    const pq = new MinPriorityQueue((item) => item[0]); // [posttime, appid]
    // We want the top k largest posttimes (most recent).
    // This minheap makes it easy to eject the smallest item whenever the heap grows past size k.
    // In the end it holds exactly the k largest posttimes, but stored in ascending order (oldest -> newest).
    for (const [appid, events] of results) {
        if (!events) continue;
        for (const { posttime } of events) {
            pq.enqueue([posttime, appid]);
            if (pq.size() > k) pq.dequeue();
        }
    }

    const arr = [];
    while (!pq.isEmpty()) {
        arr.push(pq.dequeue());
    }
    return arr.reverse(); // Make it descending order (newest -> oldest)
}

export async function sortGameUpdates(gameUpdates, requestSize, totalUpdates) {
    // Heap if requestSize << total updates
    if (requestSize && requestSize < totalUpdates / 4) {
        return topKUpdates(gameUpdates, requestSize);
    } else {
        let result = [];
        for (const [appid, events] of gameUpdates) {
            if (events) {
                for (const { posttime } of events) {
                    result.push([posttime, appid]);
                }
            }
        }
        // Otherwise Just sort everything
        if (result.length < SORT_THRESHOLD) {
            // Inline sort (fast, no worker overhead)
            result = result.sort((a, b) => b[0] - a[0]);
        } else {
            console.log(`Send to worker pool (offload ${result.length} keys to sort)`);
            result = pool.exec('sortUpdates', [result]);
        }
        if (requestSize) {
            result = result.slice(0, requestSize);
        }
        return result;
    }
}

// Clean shutdown (call at server exit)
export async function shutdownPool() {
    await pool.terminate();
}
