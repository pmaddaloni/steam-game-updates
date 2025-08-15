import axios from 'axios';
import ServerWebSocket from 'ws';

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

export const SUBSCRIPTION_BROWSER_ID_SUFFIX = ' - browser';

export function createWebSocketConnector(
    url, {
        socketType = 'frontend',
        retryInterval = 1000,
        maxRetries = 10,
        onOpen, onClose,
        onMessage: externalOnMessage,
        onError,
        showConsoleMsgs = false } = {}
) {
    let ws;
    let retries = 0;
    let isConnecting = false;
    let isClosed = false;
    let errorOccurred = false;
    let timeoutId = null;
    let onMessage = externalOnMessage;

    // The main function to establish the connection
    function connect() {
        if (isConnecting || isClosed) {
            showConsoleMsgs && console.log('Connection in progress or already closed, skipping...');
            return;
        }

        isConnecting = true;
        ws = socketType === 'frontend' ? new WebSocket(url) : new ServerWebSocket(url);
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

            // Only run the reconnect logic if an error hasn't already triggered a retry
            if (!errorOccurred && event.code !== 1000 && !isClosed) {
                if (retries < maxRetries) {
                    retries++;
                    const delay = retryInterval * Math.pow(2, retries - 1);
                    showConsoleMsgs && console.log(`Connection failed. Retrying in ${delay / 1000} seconds. Attempt ${retries}/${maxRetries}...`);
                    timeoutId = setTimeout(connect, delay);
                } else {
                    showConsoleMsgs && console.error("Max retry attempts reached. Connection failed permanently.");
                    window.alert("There was an error with the connection to the Steam Game Updates server. Please try refreshing the page.");
                    if (onError) onError("Max retries reached. Please check your connection.");
                }
            }

            // Reset the flag after the close event has been processed
            errorOccurred = false;
            if (onClose) onClose(event);
        };

        ws.onerror = (error) => {
            showConsoleMsgs && console.error("WebSocket connection error");
            isConnecting = false;
            errorOccurred = true; // Set the flag
            if (onError) onError(error);

            // This is where we initiate the retry logic for initial connection failures
            if (!isClosed && retries < maxRetries) {
                retries++;
                const delay = retryInterval * Math.pow(2, retries - 1);
                showConsoleMsgs && console.log(`Connection failed. Retrying in ${delay / 1000} seconds. Attempt ${retries}/${maxRetries}...`);
                timeoutId = setTimeout(connect, delay);
            } else if (!isClosed) {
                showConsoleMsgs && console.error("Max retry attempts reached. Connection failed permanently.");
                window && window.alert("There was an error with the connection to the Steam Game Updates server. Please try refreshing the page.");
                if (onError) onError("Max retries reached. Please check your connection.");
            }
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

export async function notifyUser(gameName, eventTitle, icon, backupLogo) {
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
            body: eventTitle,
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

const IMAGE_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml'
]);

async function isImageValid(imageUrl) {
    try {
        if (typeof window !== 'undefined') {
            return new Promise((resolve,) => {
                const img = new Image();
                const timeoutId = setTimeout(() => {
                    img.onload = null;
                    img.onerror = null;
                    resolve(false);
                }, 1000);

                img.onload = () => {
                    clearTimeout(timeoutId);
                    resolve(true);
                };

                img.onerror = () => {
                    clearTimeout(timeoutId);
                    resolve(false);
                };
                img.src = imageUrl;
            });
        }

        const response = await axios.head(imageUrl, {
            // Set a timeout to prevent the request from hanging indefinitely.
            timeout: 1000,
        });

        // Check if the status is in the success range (e.g., 200 OK).
        const isSuccess = response.status >= 200 && response.status < 300;

        // Check the Content-Type header to confirm it's an image.
        const contentType = response.headers['content-type'];
        const isImage = contentType && IMAGE_MIME_TYPES.has(contentType.split(';')[0]);

        return isSuccess && isImage;

    } catch (error) {
        // Any error (network, 404, 500, timeout, etc.) means the URL is not valid.
        console.error(`Error checking image URL ${imageUrl}:`, error.message);
        return false;
    }
}

export async function getViableImageURL(imageURLs, imageKey, appid, name = 'this game', fullUrl) {
    const localImageURLs = [...imageURLs];
    let validImageURL = null;
    do {
        const url = localImageURLs.shift();
        if (url.startsWith('api')) {
            try {
                const result = await axios.get(fullUrl ?? '/api/game-details', { params: { appid } });
                const { [imageKey]: imageURL } = result?.data;
                validImageURL = imageURL;
            } catch {
                console.error(`Could not retrieve image for ${name}.`)
            }
        } else {
            const isValidURL = await isImageValid(url);
            if (isValidURL) {
                validImageURL = url;
            }
        }
    } while (validImageURL == null && localImageURLs.length > 0)
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
