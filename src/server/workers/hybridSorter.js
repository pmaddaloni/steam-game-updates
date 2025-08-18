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

export async function sortGameUpdates(gameUpdatesIDs) {
    if (gameUpdatesIDs.length < SORT_THRESHOLD) {
        // Inline sort (fast, no worker overhead)
        return gameUpdatesIDs.sort((a, b) => b[0] - a[0]);
    } else {
        console.log('Send to worker pool (offload heavy work)');
        return pool.exec('sortUpdates', [gameUpdatesIDs]);
    }
}

// Clean shutdown (call at server exit)
export async function shutdownPool() {
    await pool.terminate();
}
