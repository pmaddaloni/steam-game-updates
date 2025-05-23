import ServerWebSocket from 'ws';
const maxRetries = 50;

export function webSocketConnectWithRetry(url, retryInterval = 3000, socketType = 'frontend') {
    let ws;
    let retries = 0;

    function attemptConnect() {
        ws = socketType === 'frontend' ? new WebSocket(url) : new ServerWebSocket(url);;

        ws.onopen = () => {
            // console.log("WebSocket connected at " + url);
        };

        ws.onclose = (event) => {
            // console.log(`WebSocket at ${ws.url} closed, reason: ${event.reason}, code: ${event.code}`);
            if (event.code !== 1000 && retries < maxRetries) { // Don't retry if closed normally
                retries++;
                setTimeout(attemptConnect, retryInterval);
            }
        };

        ws.onerror = (error) => {
            console.error("Error establishing connection with server - try refreshing.", error);
        };
    }
    attemptConnect();
    return ws;
}

/**
 * A priority queue implementation where items are prioritized by their frequency of insertion.
 * Items with higher frequencies are dequeued before those with lower frequencies.
 *
 * @class PriorityQueue
 *
 * @example
 * const pq = new PriorityQueue();
 * pq.enqueue('a');
 * pq.enqueue('b');
 * pq.enqueue('a');
 * pq.dequeue(); // 'a'
 *
 * @method enqueue Adds an item to the queue and updates its frequency.
 * @param {*} item - The item to add to the queue.
 *
 * @method dequeue Removes and returns the item with the highest frequency from the queue.
 * @returns {*} The dequeued item, or null if the queue is empty.
 *
 * @method peek Returns the item with the highest frequency without removing it.
 * @returns {*} The item at the front of the queue, or null if the queue is empty.
 *
 * @method isEmpty Checks if the queue is empty.
 * @returns {boolean} True if the queue is empty, false otherwise.
 *
 * @method size Returns the number of unique items in the queue.
 * @returns {number} The number of items in the queue.
 */
export class PriorityQueue {
    constructor() {
        this.items = [];
        this.frequencies = new Map();
    }

    enqueue(item) {
        this.frequencies.set(item, (this.frequencies.get(item) ?? 0) + 1);
        this.sort();
    }

    dequeue() {
        if (this.isEmpty()) {
            return null;
        }
        const item = this.items.shift();
        this.frequencies.delete(item);
        return item;
    }

    sort() {
        this.items = Array.from(
            this.frequencies.keys())
            .sort((a, b) => this.frequencies.get(b) - this.frequencies.get(a)
            );
    }

    peek() {
        return this.isEmpty() ? null : this.items[0];
    }

    isEmpty() {
        return this.items.length === 0;
    }

    size() {
        return this.items.length;
    }
}
