import axios from 'axios';
import ServerWebSocket from 'ws';

const MAX_RETRIES = 1000;
export function webSocketConnectWithRetry({ url, retryInterval = 3000, socketType = 'frontend', isDev = false }) {
    let ws;
    let retries = 0;
    let errorShown = false
    let interval = null;

    function attemptConnect() {
        if (interval != null) {
            retries++;
        }
        if (retries >= MAX_RETRIES) {
            clearInterval(interval);
            interval = null;
            return;
        }
        isDev && console.log(`Attempting to connect to WebSocket at ${url} (attempt ${retries + 1})`);
        ws = socketType === 'frontend' ? new WebSocket(url) : new ServerWebSocket(url);

        ws.onopen = () => {
            isDev && console.log("WebSocket connected at " + url);
            clearInterval(interval);
            retries = 0;
            errorShown = false;
        };

        ws.onclose = (event) => {
            isDev && console.log(`WebSocket at ${ws.url} closed, reason: ${event.reason}, code: ${event.code}`);
            if (event.code !== 1000 && interval == null) { // Don't retry if closed normally
                interval = setInterval(attemptConnect, retryInterval);
            }
        };

        ws.onerror = (error) => {
            console.error("Error establishing connection with server - try refreshing.", error);
            ws.close();
            if (!errorShown && retries > 10 && window) {
                errorShown = true;
                window.alert("There was an error on the server. Please try refreshing the page.");
            }
            if (interval == null) {
                interval = setInterval(attemptConnect, retryInterval);
            }
        };
    }
    attemptConnect();
    return ws;
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
