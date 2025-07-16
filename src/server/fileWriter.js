import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const fileQueue = [];
let isProcessing = false;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
process.title = 'SteamGameUpdates-FileWriter';

async function processQueue() {
    // process.send({ type: 'processing', message: `Processing ${fileQueue.length} and ${isProcessing}` });
    if (fileQueue.length === 0 || isProcessing) {
        return; // No tasks in queue or already processing
    }

    isProcessing = true;
    let task = fileQueue.shift();
    const { filename, data, directory = __dirname } = task;
    try {
        await fs.writeFile(path.join(directory, filename),
            JSON.stringify(data), (err) => {
                if (err) {
                    console.error(`Error converting JSON for ${filename}`, err);
                }
            });
        task = null;
        // Send success message back to the parent
        process.send({ type: 'success', filename: filename });
        // console.log(`Child process: Successfully wrote to ${filePath}`);
    } catch (error) {
        // Send error message back to the parent
        process.send({ type: 'error', filename: filename, error: error.message });
        // console.error(`Child process: Error writing to ${filePath}:`, error);
    } finally {
        isProcessing = false;
        processQueue();
    }
}

process.on('message', async (message) => {
    if (message.type === 'writeFile') {
        fileQueue.push(message.payload);
        processQueue();
    }
});

console.log('Child process (fileWriter.js) started.');
