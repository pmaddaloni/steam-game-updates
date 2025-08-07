import axios from 'axios';

/**
 * A robust WebSocket connection manager with an exponential backoff retry mechanism.
 * It centralizes all connection, reconnection, and error handling logic.
 *
 * @param {string} url The URL of the WebSocket server.
 * @param {object} options Configuration options.
 * @param {number} [options.retryInterval=1000] The initial delay in milliseconds before the first retry.
 * @param {number} [options.maxRetries=10] The maximum number of retry attempts.
 * @param {function} [options.onOpen] A callback function for when the connection is successfully opened.
 * @param {function} [options.onClose] A callback function for when the connection is closed.
 * @param {function} [options.onMessage] A callback function for when a message is received.
 * @param {function} [options.onError] A callback function for when a critical error occurs.
 * @returns {object} An object with methods to start and stop the connection.
 */
export function createWebSocketConnector(
    url, { retryInterval = 1000, maxRetries = 10, onOpen, onClose, onMessage: externalOnMessage, onError } = {}
) {
    let ws;
    let retries = 0;
    let isConnecting = false;
    let isClosed = false;
    let timeoutId = null;
    let onMessage = externalOnMessage;
    const showConsoleMsgs = process.env.NODE_ENV === 'development';

    // The main function to establish the connection
    function connect() {
        if (isConnecting || isClosed) {
            showConsoleMsgs && console.log('Connection in progress or already closed, skipping...');
            return;
        }

        isConnecting = true;
        ws = new WebSocket(url);
        showConsoleMsgs && console.log("Attempting to connect to WebSocket at " + url);

        // --- Event Handlers ---
        ws.onopen = () => {
            showConsoleMsgs && console.log("WebSocket connected successfully.");
            isConnecting = false;
            retries = 0; // Reset retries on success
            if (onOpen) onOpen(ws);
        };

        ws.onmessage = (event) => {
            if (onMessage) onMessage(event);
        };

        ws.onclose = (event) => {
            showConsoleMsgs && console.log(`WebSocket at ${url} closed. Reason: ${event.reason}, Code: ${event.code}`);
            isConnecting = false;
            if (onClose) onClose(event);

            // Only attempt to reconnect if the close was not normal (code 1000)
            if (event.code !== 1000 && !isClosed) {
                if (retries < maxRetries) {
                    retries++;
                    const delay = retryInterval * Math.pow(2, retries - 1); // Exponential backoff
                    showConsoleMsgs && console.log(`Connection failed. Retrying in ${delay / 1000} seconds. Attempt ${retries}/${maxRetries}...`);
                    timeoutId = setTimeout(connect, delay);
                } else {
                    showConsoleMsgs && console.error("Max retry attempts reached. Connection failed permanently.");
                    window.alert("There was an error with the connection to the Steam Game Updates server. Please try refreshing the page.");
                    // This is where you would show the alert to the user
                    if (onError) onError("Max retries reached. Please check your connection.");
                }
            }
        };

        ws.onerror = (error) => {
            // Error events are typically followed by a 'close' event, so we just log and let 'onclose' handle the retry
            showConsoleMsgs && console.error("WebSocket connection error:", error);
        };
    }

    // Public API to manage the connection
    return {
        start: () => {
            if (!ws || ws.readyState === WebSocket.CLOSED) {
                isClosed = false;
                connect();
            }
        },
        stop: () => {
            if (ws) {
                isClosed = true;
                // Clear any pending retry timeouts
                clearTimeout(timeoutId);
                // Close the connection with a normal closure code
                ws.close(1000, "User requested close.");
            }
        },
        updateOnMessage: newOnMessage => onMessage = newOnMessage,
        getSocket: () => ws
    };
}

/**
 * A priority queue implementation where appIDs are prioritized by their frequency of insertion.
 * appIDs with higher frequencies are dequeued before those with lower frequencies.
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
 * @method size Returns the number of unique appIDs in the queue.
 * @returns {number} The number of appIDs in the queue.
 */
export class PriorityQueue {
    constructor() {
        this.appIDs = [];
        this.frequencies = new Map();
    }

    enqueue(item, priority) {
        this.frequencies.set(item, (this.frequencies.get(item) ?? 0) + (priority ?? 1));
        this.sort();
    }

    dequeue() {
        if (this.isEmpty()) {
            return null;
        }
        const appID = this.appIDs.shift();
        this.frequencies.delete(appID);
        return appID;
    }

    sort() {
        this.appIDs = Array.from(
            this.frequencies.keys())
            .sort((a, b) => this.frequencies.get(b) - this.frequencies.get(a)
            );
    }

    isEmpty() {
        return this.appIDs.length === 0;
    }

    size() {
        return this.appIDs.length;
    }
}

export async function notifyUser(gameName, icon, backupLogo) {
    if (!("Notification" in window)) {
        // Check if the browser supports notifications
        console.log("This browser does not support desktop notification");
        return;
    }

    if (Notification.permission === "default") {
        // We need to ask the user for permission
        await Notification.requestPermission();
    }

    if (Notification.permission === "granted") {
        const notification = new Notification(`New Update for ${gameName}`, {
            body: `Refresh SteamGameUpdates to view latest updates for ${gameName}.`,
            icon: icon ?? backupLogo,
        });

        // Clicking should focus on the Steam Game Updates tab.
        notification.onclick = function (event) {
            event.preventDefault();
            window.focus();
            event.target.close();
        };
    }

    // If the user has denied notifications, we want
    // to be respectful - there is no need to ask them again.
}

export function checkImageURL(imageUrl) {
    return new Promise((resolve,) => {
        const img = new Image();
        img.src = imageUrl;
        img.onload = () => {
            resolve(true);
        };
        img.onerror = () => {
            resolve(false);
        };
    });
}

export async function getViableImageURL(imageURLs, imageKey, appid, name) {
    const localImageURLs = [...imageURLs];
    let validImageURL = null;
    do {
        const url = localImageURLs.shift();
        if (url.startsWith('api')) {
            try {
                const result = await axios.get('/api/game-details', { params: { appid } });
                const { [imageKey]: imageURL } = result?.data;
                validImageURL = imageURL;
            } catch {
                console.error(`Could not retrieve image for ${name}.`)
            }
        } else {
            const isValidURL = await checkImageURL(url);
            if (isValidURL) {
                validImageURL = url;
            }
        }
    } while (validImageURL === null && localImageURLs.length > 0)
    return validImageURL;
}

export function debounce(fn, delay = 55000, runOnce = false) {
    let timer = null;

    return function (...args) {
        if (timer != null) {
            clearTimeout(timer);
        }

        if (runOnce && timer == null) {
            fn.apply(this, args);
            timer = setTimeout(() => {
                timer = null;
            }, delay);
        } else {
            timer = setTimeout(() => {
                fn.apply(this, args);
                timer = null;
            }, delay);
        }
    };
}
