import axios from 'axios';
import { execSync, fork, spawn } from 'child_process';
import { RedisStore } from "connect-redis";
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import session from 'express-session';
import fs from 'fs';
import http, { createServer } from 'http';
import https from 'https';
import PQueue from 'p-queue';
import passport from 'passport';
import SteamStrategy from 'passport-steam';
import path from 'path';
import pidusage from 'pidusage';
import { createClient } from 'redis';
import url, { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import WebSocket, { WebSocketServer } from 'ws';

import config from '../../config.js';
import {
    createWebSocketConnector,
    getViableImageURL,
    PriorityQueue,
    SUBSCRIPTION_IOS_ID_SUFFIX
} from '../utilities/utils.js';
import { shutdownPool, sortGameUpdates } from './workers/hybridSorter.js';

const environment = config.ENVIRONMENT || 'development'; // Default to 'development' if not set
const PORT = process.env.PORT || 8080;
const TWO_DAYS_MS = 1000 * 60 * 60 * 24 * 2;

const __filename = fileURLToPath(import.meta.url);  // get the resolved path to the file
const __dirname = path.dirname(__filename);         // get the name of the directory

const agentOptions = {
    keepAlive: true,
    maxSockets: 50,   // concurrent sockets per host
    maxFreeSockets: 2, // keep some idle ones around
    timeout: 60000,   // close idle sockets after 60s
}
const axiosInstance = axios.create({
    httpAgent: new http.Agent(agentOptions),
    httpsAgent: new https.Agent(agentOptions),
    timeout: 15000, // avoid hung requests
});

if (environment !== 'development') {
    console.clear();
}
try {
    console.log('Running cleanup script before starting server...');
    execSync('bash ./cleanup.sh', { stdio: 'inherit' });
    console.log('Cleanup complete.');
} catch (error) {
    console.error('Cleanup script failed:', error);
    // Decide if you want to exit or continue here
    // process.exit(1);
}

process.on('SIGINT', async () => {
    console.log("Shutting down worker pool...");
    await shutdownPool();
    process.exit(0);
});

// --- redis Client Setup ---
// The redis client connects automatically, so no need for an explicit connect() call.
const redisClient = createClient({
    url: process.env.REDIS_URL || "redis://localhost:6379",
});
// const redisClient = new Redis(config.REDIS_URL || 'redis://localhost:6379');

redisClient.on('error', (err) => console.error('ioredis Client Error', err));

console.log('ioRedis client initialized. Connecting to Redis server...');

// --- Data Loading from Redis ---
// --- Data Loading from Redis ---
const getSingleRedisValue = async (field, key = 'allSteamGamesUpdates') => {
    try {
        const value = await redisClient.hGet(String(key), String(field)); // redis@5 uses camelCase
        return value ? JSON.parse(value) : null;
    } catch (err) {
        console.error("Error reading from Redis:", err);
        return null;
    }
};
// const getSingleRedisValue = async (field, key = 'allSteamGamesUpdates') => {
//     const value = await redisClient.hget(key, field);
//     return value ? JSON.parse(value) : null;
// };
await redisClient.connect();
// Passport session setup.
//   To support persistent login sessions, Passport needs to be able to
//   serialize users into and deserialize users out of the session.  Typically,
//   this will be as simple as storing the user ID when serializing, and finding
//   the user by ID when deserializing.  However, since this example does not
//   have a database of user records, the complete Steam profile is serialized
//   and deserialized.
passport.serializeUser(function (user, done) {
    done(null, user);
});

passport.deserializeUser(function (obj, done) {
    done(null, obj);
});

process.title = 'SteamGameUpdates-Server';

// Use the SteamStrategy within Passport.
//   Strategies in passport require a `validate` function, which accept
//   credentials (in this case, an OpenID identifier and profile), and invoke a
//   callback with a user object.
passport.use(new SteamStrategy({
    returnURL: (config.HOST_ORIGIN || 'http://localhost') + `${environment === 'development' ? ':8080' : ''}/api/auth/steam/return`,
    realm: config.HOST_ORIGIN || 'http://localhost:8080/',
    apiKey: config.STEAM_API_KEY,
    passReqToCallback: true,
}, function (req, identifier, user, done) {
    // check for 'JSON response invalid, your API key is most likely wrong'
    console.log('\n\nUser logged in:', user, '\n', req.session)
    process.nextTick(function () {
        user.identifier = identifier;
        if (req.session.oauthRedirectUri) {
            user.redirect_uri = req.session.oauthRedirectUri;
        }
        if (req.session.state) {
            user.state = req.session.state;
        }
        return done(null, user);
    });
}));

const DAILY_LIMIT = 250000;
const RETRY_WAIT_TIME = 5 * 60 * 1000;      // Time in minutes
const REQUEST_WAIT_TIME = 500;              // 864 would keep within 100k a day, but it appears there is no limit on updates
const NUMBER_OF_REQUESTS_PER_WAIT_TIME = 1; // Number of requests to allow per REQUEST_WAIT_TIME

console.log("Loading in data from disk...")
// Check if storage folders exist, and create if not.
const passportSessionsDirectoryPath = path.join(__dirname, './storage/passport-sessions');
if (!fs.existsSync(passportSessionsDirectoryPath)) {
    try {
        fs.mkdirSync(passportSessionsDirectoryPath, { recursive: true });   // create parent dir if need be.
        console.log(`Directory '${passportSessionsDirectoryPath}' created successfully.`);
    } catch (err) {
        console.error('Error creating directory. Must abort application and fix - check permissions.', err);
        process.exit(1);
    }
}
// End storage folders.

const allSteamGamesUpdatesPossiblyChangedFromFile = fs.existsSync(path.join(__dirname, './storage/allSteamGamesUpdatesPossiblyChanged.json')) ?
    fs.readFileSync(path.join(__dirname, './storage/allSteamGamesUpdatesPossiblyChanged.json'), { encoding: 'utf8', flag: 'r' })
    : '{}';    // {[appid]: POSSIBLE most recent update time}
const appidsWithErrors = fs.existsSync(path.join(__dirname, './storage/appidsWithErrors.json')) ?
    fs.readFileSync(path.join(__dirname, './storage/appidsWithErrors.json'), { encoding: 'utf8', flag: 'r' })
    : '[]';    // [appid]
const appidsToCheckIndex = fs.existsSync(path.join(__dirname, './storage/appidsToCheckIndex.json')) ?
    fs.readFileSync(path.join(__dirname, './storage/appidsToCheckIndex.json'), { encoding: 'utf8', flag: 'r' })
    : '0';     // For incrementing through ALL steam games - ~ 100k requests/day
const steamGameDetails = fs.existsSync(path.join(__dirname, './storage/steamGameDetails.json')) ?
    fs.readFileSync(path.join(__dirname, './storage/steamGameDetails.json'), { encoding: 'utf8', flag: 'r' })
    : '{}';    // {[appid]: {name, img_icon_url, img_logo_url, ...}}
const serverRefreshTimeAndCount = fs.existsSync(path.join(__dirname, './storage/serverRefreshTimeAndCount.json')) ?
    fs.readFileSync(path.join(__dirname, './storage/serverRefreshTimeAndCount.json'), { encoding: 'utf8', flag: 'r' })
    : JSON.stringify([new Date().getTime(), 0]); // Last time the server was refreshed (i.e. daily limit reset) and the last recorded daily limit
const mobileSessions = fs.existsSync(path.join(__dirname, './storage/mobileSessions.json')) ?
    fs.readFileSync(path.join(__dirname, './storage/mobileSessions.json'), { encoding: 'utf8', flag: 'r' })
    : '{}';    // [ sessionID-1, sessionID-2, ... ]
const userOwnedGames = fs.existsSync(path.join(__dirname, './storage/userOwnedGames.json')) ?
    fs.readFileSync(path.join(__dirname, './storage/userOwnedGames.json'), { encoding: 'utf8', flag: 'r' })
    : '{}';
const subscribedUserFilters = fs.existsSync(path.join(__dirname, './storage/subscribedUserFilters.json')) ?
    fs.readFileSync(path.join(__dirname, './storage/subscribedUserFilters.json'), { encoding: 'utf8', flag: 'r' })
    : '{}'; // { userID: [filter1, filter2, ...] }

const app = express();
app.locals.requestQueue = new PQueue({ interval: REQUEST_WAIT_TIME, intervalCap: NUMBER_OF_REQUESTS_PER_WAIT_TIME });
app.locals.appidsToCheckPriorityQueue = new PriorityQueue();

function makeRequest(url, method = 'get') {
    return () => axiosInstance[method](url);
};

// https://stackoverflow.com/questions/33030092/webworkers-with-a-node-js-express-application
async function getAllSteamGameNames() {
    return app.locals.requestQueue.add(
        makeRequest('https://api.steampowered.com/ISteamApps/GetAppList/v0002/')
    ).then((result) => {
        // disregard apps without a name
        let games = result.data.applist.apps.filter(app => app.name !== '');//.sort((a, b) => a.appid - b.appid);
        const gameNamesDict = games.reduce((acc, game) => {
            acc[game.appid] = game.name;
            return acc;
        }, {});
        // Remove appid duplicates that can be present in the returned list
        // This isn't ideal, but it appears to be the most efficient way to do this, and is pretty fast.
        games = Array.from(new Set(games.map(a => a.appid)));
        games = games.map((appid) => ({
            appid,
        }));
        console.log(`Server has retrieved ${games.length} games`);
        return { gameAppidsArray: games, gameNamesDict };
    }).catch(err => {
        console.error('Retrieving all games from Steam API failed.', err);
    })
}

const { gameAppidsArray, gameNamesDict } = await getAllSteamGameNames();
app.locals.allSteamGames = gameAppidsArray;
// app.locals.allSteamGamesUpdates = allSteamGamesUpdates;
app.locals.allSteamGameNames = gameNamesDict;
app.locals.steamGameDetails = JSON.parse(steamGameDetails);
app.locals.allSteamGamesUpdatesPossiblyChanged = JSON.parse(allSteamGamesUpdatesPossiblyChangedFromFile);
app.locals.appidsToCheckIndex = parseInt(JSON.parse(appidsToCheckIndex));
app.locals.appidsWithErrors = new Set(JSON.parse(appidsWithErrors));
const parsedUserOwnedGames = JSON.parse(userOwnedGames);
const objectWithSets = Object.entries(parsedUserOwnedGames).reduce((acc, [key, value]) => {
    acc[key] = new Set(value);
    return acc;
}, {});
app.locals.gamesWithSubscriptions = objectWithSets;
app.locals.waitBeforeRetrying = false;
const [lastStartTime, lastDailyLimitUsage = 0] = JSON.parse(serverRefreshTimeAndCount);
app.locals.dailyLimit = DAILY_LIMIT - lastDailyLimitUsage;
app.locals.lastServerRefreshTime = lastStartTime ?? new Date().getTime();
// Since passport isn't properly tracking mobile sessions, we need to track them ourselves.
// We generate our own UUIDs to check against for the mobile app.
app.locals.mobileSessions = JSON.parse(mobileSessions);
app.locals.subscribedUserFilters = JSON.parse(subscribedUserFilters);

// START Steam Game Updates WebSocket connection
const webSocketServerOptions = { noServer: true };
// For now NGINX handles the secure connection to the outside world
// if (environment !== 'development') {
//     webSocketServerOptions.server = createServer({
//         key: fs.readFileSync(config.SSL_KEY_PATH),
//         cert: fs.readFileSync(config.SSL_CERT_PATH),
//     });
// }
const wss = new WebSocketServer(webSocketServerOptions);
wss.on('connection', function connection(ws, req) {
    const id = decodeURIComponent(req.url.split('=')?.[1] || '').trim();
    console.log(`WebSocket connection established with a client with Steam ID ${id}`);
    ws.id = id;
    ws.on('error', console.error);
    ws.on('close', () => {
        console.log(`Client with Steam ID ${id} disconnected.`);
    });
});
// END Steam Game Updates WebSocket connection

// --- OneSignal Configuration ---
const ONE_SIGNAL_APP_ID = config.ONE_SIGNAL_APP_ID;
const ONE_SIGNAL_REST_API_KEY = config.ONE_SIGNAL_REST_API_KEY;

async function sendIndividualNotifications({ appid, name, eventTitle, eventType }) {
    if (app.locals.gamesWithSubscriptions[appid] != null) {
        let usersToNotify =
            [...app.locals.gamesWithSubscriptions[appid]]
                .filter(userId => userId.endsWith(SUBSCRIPTION_IOS_ID_SUFFIX))
                .filter(userId => app.locals.subscribedUserFilters[userId]?.includes(eventType) === false);

        if (usersToNotify.length === 0) {
            return;
        }
        try {
            const icons = [
                `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/capsule_616x353.jpg`,
                `https://steamcdn-a.akamaihd.net/steam/apps/${appid}/logo.png`,
                `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
                `https://steamcdn-a.akamaihd.net/steam/apps/${appid}/header.jpg`,
                // `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${appid}/${ownedGames[appid].img_logo_url}.jpg`,
                // `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${appid}/${ownedGames[appid].img_icon_url}.jpg`
                'api'
            ]
            const fullUrl = `http://localhost:${PORT}/api/game-details`;
            const validImageURL = await getViableImageURL(icons, 'id', appid, name, fullUrl);

            const notification = {
                app_id: ONE_SIGNAL_APP_ID,
                target_channel: 'push',
                contents: {
                    'en': eventTitle,
                },
                headings: {
                    'en': `New Update for ${name}`,
                },
                ios_attachments: {
                    'id': {
                        'url': validImageURL
                    }
                },
                'include_aliases': {
                    'external_id': usersToNotify
                },
                ios_badgeType: 'Increase',
                ios_badgeCount: 1,
            }
            const result = await axios.post(
                'https://onesignal.com/api/v1/notifications?c=push',
                notification,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Key ${ONE_SIGNAL_REST_API_KEY}`,
                    },
                }
            );
            console.log(`Notification sent to users for app ${appid} (${name}):`, result.data);
        } catch (error) {
            console.error(`Error sending notification to users for app ${appid}:`, error.response ? error.response.data : error.message);
        }
    }
}
// End OneSignal client configuration

// Spin up SteamWebPipes server
const MEMORY_LIMIT_MB = 100;
const MEMORY_LIMIT_BYTES = MEMORY_LIMIT_MB * 1024 * 1024;
const MONITOR_INTERVAL_MS = 30000; // Check every 30 seconds

let steamWepPipesProcess = null
let ws = null;
function initializeSteamWebPipes() {
    steamWepPipesProcess = spawn(path.join(__dirname, '../../SteamWebPipes-master/bin/SteamWebPipes'));
    // SteamWebPipes WebSocket setup
    console.log('Setting up SteamWebPipes server...');
    ws = createWebSocketConnector('ws://localhost:8181', {
        ServerWebSocket: WebSocket,
        showConsoleMsgs: true || environment === 'development',
        onMessage: (message) => {
            const { Apps: apps } = JSON.parse(message.data);
            if (apps == null) {
                return;
            }
            const appids = Object.keys(apps);
            for (const appid of appids) {
                app.locals.allSteamGamesUpdatesPossiblyChanged[appid] = new Date().getTime() / 1000; // convert to seconds from ms
                // If at least one subscribed user owns the game, we should check it.
                if (app.locals.gamesWithSubscriptions[appid]?.size > 0) {
                    console.log(`Game ${appid} has updates, checking for changes...`);
                    app.locals.appidsToCheckPriorityQueue.enqueue(appid, app.locals.allSteamGamesUpdatesPossiblyChanged[appid]);
                }
            }
        },
        onClose: () => console.log('Disconnected from SteamWebPipes server'),
        onOpen: () => console.log('Connected to SteamWebPipes server'),
        onError: (error) => console.error('SteamWebPipes error:', error)
    });
    ws.start();
}
initializeSteamWebPipes();

// CHECK MEMORY INTERVAL
/* setInterval(() => {
    // Get the memory usage object from the Node.js process.
    const memoryUsage = process.memoryUsage();
    const totalMemoryBytes = os.totalmem();
    const freeMemoryBytes = os.freemem();

    const usedMemoryBytes = totalMemoryBytes - freeMemoryBytes;

    // Define constants for conversion.
    const ONE_MB = 1024 * 1024;
    const ONE_GB = 1024 * ONE_MB;

    // The main metric to check for switching units is RSS.
    const rssInMB = memoryUsage.rss / ONE_MB;

    let unit = 'MB';
    let divisor = ONE_MB;

    // Check if RSS is over 1000 MB (approximately 1 GB).
    if (rssInMB >= 1000) {
        unit = 'GB';
        divisor = ONE_GB;
    }
    const convertAndFormat = (bytes) => (bytes / divisor).toFixed(2);

    console.log('\n--- Current RAM Usage ---');
    console.log(`System Total RAM: ${convertAndFormat(totalMemoryBytes)} ${unit}`);
    console.log(`System Free RAM:  ${convertAndFormat(freeMemoryBytes)} ${unit}`);
    console.log(`System Used RAM:  ${convertAndFormat(usedMemoryBytes)} ${unit}`);
    console.log('---');
    console.log(`Resident Set Size (RSS): ${convertAndFormat(memoryUsage.rss)} ${unit}`);
    console.log(`Heap Total: ${convertAndFormat(memoryUsage.heapTotal)} ${unit}`);
    console.log(`Heap Used: ${convertAndFormat(memoryUsage.heapUsed)} ${unit}`);
    console.log(`External: ${convertAndFormat(memoryUsage.external)} ${unit}`);
    console.log('-------------------------\n');
}, 5000) */

setInterval(() => {
    if (steamWepPipesProcess?.exitCode == null && steamWepPipesProcess.signalCode == null) {
        pidusage(steamWepPipesProcess.pid)
            .then(stats => {
                // stats.memory is in bytes (RSS - Resident Set Size)
                // const memoryMB = stats.memory / (1024 * 1024);
                // console.log(`SteamWebPipes process (PID: ${steamWepPipesProcess.pid}) memory usage: ${memoryMB.toFixed(2)} MB`);

                if (stats.memory > MEMORY_LIMIT_BYTES) {
                    console.warn(`SteamWebPipes process (PID: ${steamWepPipesProcess.pid}) exceeded memory limit (${MEMORY_LIMIT_MB} MB). Killing it.`);
                    steamWepPipesProcess.kill('SIGKILL'); // Use SIGKILL for immediate termination
                    initializeSteamWebPipes()
                }
            })
            .catch(err => {
                console.error('Error getting child process memory usage:', err);
            });
    } else {
        // If the child process is no longer active for some reason, restart it
        console.warn('Child process is not running. Restarting SteamWebPipes server...');
        initializeSteamWebPipes()
    }
}, MONITOR_INTERVAL_MS);

let fileWriterProcess = null;
const childProcessPath = path.resolve(path.join(__dirname, './fileWriter.js'));
const initializeFileWriterProcess = () => {
    fileWriterProcess = fork(childProcessPath);

    const pendingRequests = new Map();
    let requestIdCounter = 0;

    fileWriterProcess.on('message', (message) => {
        // Check if it's a response to a pending request
        if (pendingRequests.has(message.requestID)) {
            const { resolve, reject } = pendingRequests.get(message.requestID);
            pendingRequests.delete(message.requestID);

            if (message.type === 'success') {
                console.log(`FileWriter: File "${message.filename}" written successfully.`);
                resolve(message.data);
            } else if (message.type === 'error') {
                console.error(`FileWriter: Error writing "${message.filename}":`, message.error);
                reject(new Error(message.error || 'Unknown error'));
            }
        }
    });

    fileWriterProcess.on('exit', (code, signal) => {
        console.warn(`FileWriter process exited with code ${code} and signal ${signal}.`);
        // If the child process exits unexpectedly, restart it
        fileWriterProcess = null;
        // setTimeout(initializeFileWriterProcess, 1000);
    });

    fileWriterProcess.on('error', (err) => {
        console.error('FileWriter process encountered an error:', err);
    });

    console.log('FileWriter child process initialized.');

    return function sendRequest({ type, payload }) {
        return new Promise((resolve, reject) => {
            const requestID = ++requestIdCounter;
            pendingRequests.set(requestID, { resolve, reject });

            fileWriterProcess.send({
                type,
                requestID,
                payload
            });

            // // Optional: Add a timeout for requests to prevent hanging
            // setTimeout(() => {
            //     if (pendingRequests.has(requestId)) {
            //         pendingRequests.delete(requestId);
            //         reject(new Error(`Request ${requestId} timed out`));
            //     }
            // }, 15000); // 15 seconds timeout
        });
    }
};

const ensureAuthenticated = function (req, res, next) {
    if (req.isAuthenticated() || app.locals.mobileSessions[req.headers['session-id']] == null) {
        return next();
    }
    console.error('User is not authenticated:',
        req.user, req.headers['session-id'],
        app.locals.mobileSessions[req.headers['session-id']]);
    res.sendStatus(401);
}

async function getAppidUpdates(
    appid,
    prioritizedRequest = false,
    includeCountBefore = true,
    includeCountAfter = true
) {
    let result = null;
    if (appid == null) {
        return {
            status: 500,
            retryAfter: -1,
        };
    }
    try {
        const response =
            await app.locals.requestQueue.add(
                makeRequest(
                    'https://store.steampowered.com/events/ajaxgetadjacentpartnerevents' +
                    `?appid=${appid}` +
                    (includeCountBefore ? '&count_before=0' : '') +
                    (includeCountAfter ? '&count_after=100' : '')),
                { priority: prioritizedRequest ? 2 : 0 }
            );
        result = response.data;
    } catch (err) {
        console.error(`Getting the game ${appid}'s updates failed.`, err.message, '\n', err.response?.status, '\n', err.response?.data,);
        let resultRetryAfter = err.response?.headers?.['retry-after'];
        if (resultRetryAfter) {
            resultRetryAfter = parseInt(resultRetryAfter, 10);
        }
        if (err.response?.status === 429) {
            if (resultRetryAfter) {
                const retryAfter = resultRetryAfter ?? 5 * 60; // Default to 5 minutes if no Retry-After header is found
                result = {
                    status: 429,
                    retryAfter
                }
            }
        } else if (err.response?.status === 403) {
            result = {
                status: 403,
                retryAfter: resultRetryAfter
            }
        } else if (err.response?.data.eresult === 42 &&
            (includeCountBefore || includeCountAfter)) {
            const shouldIncludeCountBefore = (!includeCountBefore || includeCountAfter) &&
                !(includeCountBefore && includeCountAfter);
            const shouldIncludeCountAfter = includeCountBefore && includeCountAfter;
            console.log(`Retrying ${appid} request with shouldIncludeCountBefore:` +
                `${shouldIncludeCountBefore}, shouldIncludeCountAfter: ${shouldIncludeCountAfter}`)
            // retry in this order, after using both params failed:
            // 1. Try with count_before as false, but count_after is true.
            // 2. If #1 fails, then try with count_before being true, and count_after as false.
            // 3. If #2 fails try both as false.
            // 4. If that fails then give up.
            return getAppidUpdates(
                appid,
                prioritizedRequest,
                shouldIncludeCountBefore,
                shouldIncludeCountAfter
            )
        } else {
            // Something went wrong other than rate limiting
            result = {
                status: err.response?.status,
                retryAfter: -1,
            }
        }
    }
    return result;
}

console.log(`Server last refreshed on ${new Date(app.locals.lastServerRefreshTime)} with ${app.locals.dailyLimit} requests left`);

// https://steamcommunity.com/dev/apiterms#:~:text=any%20Steam%20game.-,You%20may%20not%20use%20the%20Steam%20Web%20API%20or%20Steam,Steam%20Web%20API%20per%20day.
// Reset the daily limit every 24 hours
function getNextMidnight() {
    const now = new Date();

    // Create a new Date object for tomorrow.
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);

    // Set the time of tomorrow to midnight (00:00:00).
    tomorrow.setHours(0, 0, 0, 0);
    const delay = tomorrow.getTime() - now.getTime();

    console.log(`Next refresh will be scheduled to run in ${delay} ms at: ${tomorrow}`);
    // Calculate the delay in milliseconds until tomorrow at midnight.
    return delay;
}
function scheduleDailyReset() {
    setTimeout(() => {
        app.locals.dailyLimit = DAILY_LIMIT;
        app.locals.lastServerRefreshTime = Date.now();
        console.log("Daily reset at midnight");

        // re-schedule for the next midnight
        scheduleDailyReset();
    }, getNextMidnight());
}
scheduleDailyReset();

// Log out all users every 2 days.
// Maybe make this longer in the future.
function scheduleExpiry(sessionID, session) {
    const now = Date.now();
    const delay = session.expiresAt - now;
    const id = session.id + SUBSCRIPTION_IOS_ID_SUFFIX;
    if (delay <= 0) {
        // already expired
        delete app.locals.mobileSessions[sessionID];
        delete app.locals.gamesWithSubscriptions[id];
        delete app.locals.subscribedUserFilters[id];
        console.log(`Session ${sessionID} expired on load`);
        return;
    }

    setTimeout(() => {
        delete app.locals.mobileSessions[sessionID];
        delete app.locals.gamesWithSubscriptions[id];
        delete app.locals.subscribedUserFilters[id];
        console.log(`Session ${sessionID} expired after TTL`);
    }, delay);
};

// when adding a new session
function addSession(sessionID, data) {
    const expiresAt = Date.now() + TWO_DAYS_MS;
    app.locals.mobileSessions[sessionID] = { ...data, expiresAt };
    scheduleExpiry(sessionID, data);
}

// restore timers
Object.entries(app.locals.mobileSessions).forEach(([key, session]) => {
    scheduleExpiry(app.locals.mobileSessions, key, session);
});

// Clear
setInterval(() => {
    app.locals.gamesWithSubscriptions = {};
    app.locals.subscribedUserFilters = {};
    const dir = path.join(__dirname, './storage/passport-sessions')
    fs.readdirSync(dir).forEach(f => fs.rmSync(`${dir}/${f}`));
}, (1000 * 60 * 60 * 24) * 2);

// Refresh all games every hour
// At this point it's not cleared/guaranteed that the games will always come back in the
// same order, but it appears to be the case, at least for now.
setInterval(async () => {
    console.log('Refreshing all games');
    if (app.locals.dailyLimit > 0 && app.locals.waitBeforeRetrying === false) {
        getAllSteamGameNames().then(({ gameAppidsArray, gameNamesDict }) => {
            app.locals.dailyLimit--;
            if (gameAppidsArray) {
                app.locals.allSteamGames = gameAppidsArray;
                app.locals.allSteamGameNames = gameNamesDict;
            } else {
                app.locals.waitBeforeRetrying = true;
                setTimeout(() => app.locals.waitBeforeRetrying = false, RETRY_WAIT_TIME);
            }
        });
    }
}, 60 * 60 * 1000)

const getGameUpdates = async (externalAppid) => {
    if (app.locals.dailyLimit > 0
        && app.locals.waitBeforeRetrying === false) {

        const priorityAppid = app.locals.appidsToCheckPriorityQueue.dequeue();
        if (externalAppid != null) {
            console.log('External appid:', externalAppid, app.locals.appidsToCheckPriorityQueue.size());
        } else if (priorityAppid != null) {
            console.log('Priority appid:', priorityAppid, app.locals.appidsToCheckPriorityQueue.size());
        }

        let appid = externalAppid ?? priorityAppid
            ?? app.locals.allSteamGames[app.locals.appidsToCheckIndex]?.appid;

        if (appid == null) {
            app.locals.appidsToCheckIndex = 0; // Loop back to the beginning
            appid = app.locals.allSteamGames[0].appid;
        }

        // Skip the appid if it has already been checked and failed, and this wasn't a manual request.
        if (app.locals.appidsWithErrors.has(appid) && !externalAppid && !priorityAppid) {
            app.locals.appidsToCheckIndex++;
        } else {
            //  If a user has requested a specific appid we need to process it asap.
            const result = await getAppidUpdates(appid, !!externalAppid);
            app.locals.dailyLimit--;

            if (result.success === 1) {
                // Only increment the index if this was not a manual request.
                if (externalAppid == null && priorityAppid == null) {
                    app.locals.appidsToCheckIndex++;
                }

                // To keep track of the most recent 10 updates -> .slice(0, 10)
                const mostRecentEvents = result.events.map(event => {
                    const { posttime, body, gid, headline } = event.announcement_body;
                    return { posttime, body, gid, headline, event_type: event.event_type };
                });
                const mostRecentEventTime = (mostRecentEvents[0]?.posttime ?? 0);
                const mostRecentPreviouslyKnownEventTime = (await getSingleRedisValue(appid))?.[0]?.posttime ?? 0;

                // Since we just got the most recent updates, this can be set to that event's post time.
                app.locals.allSteamGamesUpdatesPossiblyChanged[appid] =
                    Math.max(mostRecentEventTime, mostRecentPreviouslyKnownEventTime);
                // redisClient.hset('allSteamGamesUpdates', appid, JSON.stringify(mostRecentEvents));
                await redisClient.hSet('allSteamGamesUpdates', {
                    [String(appid)]: JSON.stringify(mostRecentEvents),
                });

                if (true || (mostRecentEvents.length > 0 && mostRecentPreviouslyKnownEventTime < mostRecentEventTime)) {
                    const name = app.locals.allSteamGameNames[appid];
                    const eventType = mostRecentEvents[0]?.event_type;
                    const eventTitle = mostRecentEvents[0]?.headline || 'New Update';
                    console.log(`Game ${name} (${appid}) has new updates (${eventType}):`, mostRecentEvents.length, 'events, most recent at', new Date(mostRecentEventTime * 1000).toLocaleString());
                    console.log(app.locals.subscribedUserFilters, '\n', app.locals.gamesWithSubscriptions[appid], '\n')
                    // Notify mobile users of the new updates.
                    sendIndividualNotifications({ appid, name, eventTitle, eventType });

                    // Also let web clients know a new update has been processed.
                    if (app.locals.gamesWithSubscriptions[appid] != null) {
                        const usersToNotify = [...app.locals.gamesWithSubscriptions[appid]]
                            .filter(userId => app.locals.subscribedUserFilters[userId]?.includes(eventType) === false)

                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN && usersToNotify.includes(client.id)) {
                                client.send(JSON.stringify({
                                    appid,
                                    name,
                                    eventTitle,
                                }));
                            }
                        });
                    }
                }
                console.log(`Getting the game ${appid}'s updates completed with ${mostRecentEvents.length ?? 0} event(s), with ${DAILY_LIMIT - app.locals.dailyLimit} requests so far.`);
            } else if (result.status === 429 || result.status === 403) {
                if (result.status === 429 || result.retryAfter != null) {
                    app.locals.waitBeforeRetrying = true;
                    setTimeout(() => app.locals.waitBeforeRetrying = false, result.retryAfter != null ? result.retryAfter * 1000 : RETRY_WAIT_TIME);
                } else {
                    //  Steam is refusing requests and hasn't given a retry time, so let's backoff for the rest of the day.
                    app.locals.dailyLimit = 0; // Stop processing any more requests for the day.
                }
                console.log(`${result.status === 403 ?
                    'Steam API is refusing' : 'Steam API rate limit reached'};
                    ${result.retryAfter != null ? `retrying after: ${result.retryAfter} seconds.` : 'retrying again tomorrow'}
                `);
            } else {
                // This appid has not been found for whatever reason, so don't try it again.
                app.locals.appidsWithErrors.add(appid);
                // Only increment the index if this was not a manual request.
                if (externalAppid == null && priorityAppid == null) {
                    app.locals.appidsToCheckIndex++;
                }
            }
        }
    }

    if (app.locals.dailyLimit === 0) {
        app.locals.dailyLimit = -1; // Prevent message below from printing over and over.
        console.log(`Daily limit reached at ${new Date()}. Waiting for the next day to continue.`);
    }
}

// Continuously fetch game's updates every 1 second iterating over the allgames array.
// Constraint of 100000k allows for an average of one request every 0.86 seconds over 24 hours.
// Constraint of 200 per 5 minutes restricts to no more than one request every 1.5 seconds within any 5 - minute window.
// 200 constraint doesn't appear to affect this request...
setInterval(getGameUpdates, REQUEST_WAIT_TIME);

// FILE WRITE
// Save the results every 30 minute so we don't lose them if the server restarts/crashes.
setInterval(async () => {
    // We may as well stop saving the files if the daily limit is 0 so we don't keep writing
    // the same data over and over again.
    if (app.locals.dailyLimit > -2 && fileWriterProcess == null) {
        // Save once after the daily limit is reached, then stop.
        if (app.locals.dailyLimit === -1) {
            app.locals.dailyLimit = -2;
        }

        const fileWriterSend = initializeFileWriterProcess(); // Initialize the child process on server start
        try {
            await fileWriterSend({
                type: 'writeFile',
                payload: {
                    filename: './storage/appidsWithErrors.json',
                    data: Array.from(app.locals.appidsWithErrors),
                }
            });

            await fileWriterSend({
                type: 'writeFile',
                payload: {
                    filename: './storage/appidsToCheckIndex.json',
                    data: (app.locals.appidsToCheckIndex || 0).toString(),
                }
            });

            await fileWriterSend({
                type: 'writeFile',
                payload: {
                    filename: './storage/allSteamGamesUpdatesPossiblyChanged.json',
                    data: app.locals.allSteamGamesUpdatesPossiblyChanged,
                }
            });
            await fileWriterSend({
                type: 'writeFile',
                payload: {
                    filename: './storage/serverRefreshTimeAndCount.json',
                    data: [app.locals.lastServerRefreshTime, app.locals.dailyLimit],
                }
            });
            await fileWriterSend({
                type: 'writeFile',
                payload: {
                    filename: './storage/steamGameDetails.json',
                    data: app.locals.steamGameDetails,
                }
            });
            await fileWriterSend({
                type: 'writeFile',
                payload: {
                    filename: './storage/mobileSessions.json',
                    data: app.locals.mobileSessions,
                }
            });
            await fileWriterSend({
                type: 'writeFile',
                payload: {
                    filename: './storage/gamesWithSubscriptions.json',
                    data: Object.entries(app.locals.gamesWithSubscriptions).reduce((acc, [key, value]) => {
                        acc[key] = Array.from(value);
                        return acc;
                    }, {}),
                }
            });
            await fileWriterSend({
                type: 'writeFile',
                payload: {
                    filename: './storage/subscribedUserFilters.json',
                    data: app.locals.subscribedUserFilters,
                }
            });
        } catch (err) {
            if (err) {
                console.error('Error writing to files occurred...', err);
            }
        }
        fileWriterProcess.kill();
    }
}, 30 * 60 * 1000);

const sessionSecret = config.STEAM_GAME_UPDATES_SECRET;
const store = new RedisStore({         // Use Redis as the session store
    client: redisClient,
    prefix: 'sessions:',
    ttl: TWO_DAYS_MS / 1000, // redis expects seconds
});
const sessionOptions = {
    secret: sessionSecret,
    name: 'steam-game-updates',
    resave: false,
    saveUninitialized: false,       // Only save sessions if something is stored
    store,
    cookie: {
        maxAge: TWO_DAYS_MS,        // Set the time to live for sessions to 2 days
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    }
};
const sessionMiddleware = session(sessionOptions);
// if (environment !== 'development') {
//     sessionOptions.cookie = {
//         ...sessionOptions.cookie,
//         sameSite: 'none',  // Required for cross-site requests
//         secure: true,      // Must be true when sameSite is 'none'
//     };
// }
app.use(sessionMiddleware);
app.set('trust proxy', 1);
// Initialize Passport and use passport.session() middleware to support persistent login sessions.
app.use(passport.initialize());
app.use(passport.session());
app.use(cors({
    origin: environment === 'development' ?
        (config.HOST_ORIGIN || 'http://localhost') + (config.HOST_ORIGIN_PORT || ':3000') : 'https://steamgameupdates.info',
    methods: ['GET', 'POST'],
    credentials: true,          // Allow cookies to be sent with requests
    optionsSuccessStatus: 200   // some legacy browsers (IE11, various SmartTVs) choke on 204
}));

// Middleware to parse JSON and URL-encoded bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(sessionSecret));


// Set up view engine
app.set('views', path.join(__dirname, './views'));
app.set('view engine', 'ejs');

app.use(express.static(path.join(__dirname, '../../build')));

app.get('/close', function (req, res) {
    res.render('close', { user: req.user });
});

app.get('/error', function (req, res) {
    console.log('Error page requested', req.user, req.state, req);
    res.render('error', { messages: req.sessions?.messages, user: req.user });
});

app.get('/api/user', ensureAuthenticated, (req, res) => {
    if (req.user == null) {
        res.sendStatus(200);
    } else {
        res.json(req.user);
    }
});

app.get('/api/owned-games', ensureAuthenticated, async (req, res) => {
    if (req.app.locals.waitBeforeRetrying === false && req.app.locals.dailyLimit > 0) {
        let result = '';
        const userID = req.query.id || req.user?.id;
        if (!userID) {
            return res.status(400).send(new Error('No user ID provided'));
        }

        //  If a user has requested their games we need to process it asap.
        await app.locals.requestQueue.add(
            makeRequest(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${config.STEAM_API_KEY}&steamid=${userID}&include_appinfo=true&skip_unvetted_apps=true`),
            { priority: 3 }   // Prioritize this request above all others
        )
            .then(response => { result = response })
            .catch(err => {
                console.error(`\nGetting the user ${req.query.id}'s owned games FAILED with code "${err.response?.status}"`
                    + ` and message "${err.response?.statusText} (no code means the server didn't responsd).\n`, err);
                app.locals.waitBeforeRetrying = true;
                setTimeout(() => app.locals.waitBeforeRetrying = false, err.response?.retryAfter != null ? err.response?.retryAfter * 1000 : RETRY_WAIT_TIME);
            });
        app.locals.dailyLimit--;
        console.log(`Getting the user ${req.query.id}'s owned games completed with ${result.data?.response?.game_count ?? 'no'} games`);
        res.send(result.data?.response);
    } else {
        res.status(429).json({
            error: `The limit for requests has been reached`,
            waitBeforeRetrying: req.app.locals.waitBeforeRetrying,
            dailyLimit: req.app.locals.dailyLimit,
        });
    }
});

app.get('/api/all-steam-games', ensureAuthenticated, async (req, res) => {
    res.send(req.app.locals.allSteamGames);
});

app.get('/api/update-queue', ensureAuthenticated, async (req, res) => {
    res.send(req.app.locals.allSteamGames);
});

app.post('/api/game-updates', ensureAuthenticated, async (req, res) => {
    const appid = req.query.appid;
    app.locals.appidsToCheckPriorityQueue.enqueue(appid, Infinity); // Give this request a high priority
    res.sendStatus(200);
});

const notificationUnsubscribe = (req) => {
    const userID = req.body.id || req.user?.id;
    const appids = (req.body.appids ?? []).map(appid => parseInt(appid));

    for (const appid of appids) {
        if (app.locals.gamesWithSubscriptions[appid] != null) {
            app.locals.gamesWithSubscriptions[appid].delete(userID);
        }
    }
    delete app.locals.subscribedUserFilters[userID];
};

const notificationSubscribe = (req) => {
    const userID = req.body.id || req.user?.id;
    const appids = (req.body.appids ?? []).map(appid => parseInt(appid));
    const filters = (req.body.filters ?? []).map(appid => parseInt(appid));
    console.log('APP ID:', userID, '\n\n');

    app.locals.subscribedUserFilters[userID] = filters;
    for (const appid of appids) {
        if (userID != null) {
            if (app.locals.gamesWithSubscriptions[appid] == null) {
                app.locals.gamesWithSubscriptions[appid] = new Set();
            }
            app.locals.gamesWithSubscriptions[appid].add(userID);
        }
    }
};

app.post('/api/notifications/filters', ensureAuthenticated, async (req, res) => {
    const userID = req.body.id || req.user?.id;
    const filters = (req.body.filters ?? []).map(appid => parseInt(appid));

    if (userID == null || filters == null) {
        res.sendStatus(400, `Check your request body to ensure it has the correct format: { id: <userID>, filters: [<appid1>, ...] }.`);
        return;
    }
    app.locals.subscribedUserFilters[userID] = filters;
    res.sendStatus(200);
});

// A temp map entry with the UUID from POST
// lookup all entries and then store in map
const tempMap = {};
app.post('/api/beta/game-updates-for-owned-games', ensureAuthenticated, async (req, res) => {
    const appids = (req.body.appids ?? []).map(Number);
    const requestID = req.body.request_id;
    const requestSize = parseInt(req.body.request_size ?? 0, 10);

    if (!requestID) {
        res.sendStatus(406);
        return;
    }
    notificationSubscribe(req);

    // Parallelized Redis fetches
    const gameUpdates = await Promise.all(
        appids.map(async (appid) => {
            const events = await getSingleRedisValue(appid);
            if (
                events == null ||
                app.locals.allSteamGamesUpdatesPossiblyChanged[appid] > (events[0]?.posttime ?? 0)
            ) {
                app.locals.appidsToCheckPriorityQueue.enqueue(appid, events?.[0]?.posttime);
            }
            return [appid, events];
        })
    );

    const updates = Object.fromEntries(gameUpdates.filter(([, events]) => events != null));
    const totalUpdates = gameUpdates.reduce(
        (sum, [, events]) => sum + (events ? events.length : 0),
        0
    );

    // Sort by posttime descending
    const gameUpdatesIDs = await sortGameUpdates(gameUpdates, requestSize, totalUpdates)
    tempMap[requestID] = {
        updates,
        gameUpdatesIDs,
        retrievalAmount: requestSize || null,
        cursor: 0,
    };

    // Clean up after 5 min
    setTimeout(() => delete tempMap[requestID], 1000 * 60 * 5);
    res.send({ gameUpdatesIDs, totalUpdates });
});

// GET endpoint that returns paginated results and
// once the end is reached, delete the temp map entry.
app.get('/api/beta/game-updates-for-owned-games', ensureAuthenticated, async (req, res) => {
    const requestID = req.query.request_id;
    const requestSize = parseInt(req.query.fetch_size ?? '150', 10);

    const entry = tempMap[requestID];
    if (entry == null) {
        return res.sendStatus(404);
    }

    const { updates, gameUpdatesIDs, retrievalAmount, cursor } = entry;
    let updatesChunk = {};
    let hasMore = true;

    try {
        let newCursor = cursor;
        let toSend = 0;

        while (
            toSend < requestSize &&
            (retrievalAmount == null || entry.retrievalAmount > 0) &&
            newCursor < gameUpdatesIDs.length
        ) {
            const [, appid] = gameUpdatesIDs[newCursor++];
            if (updates[appid] != null && updatesChunk[appid] == null) {
                updatesChunk[appid] = updates[appid];
                if (retrievalAmount != null) entry.retrievalAmount--;
                delete updates[appid];
                toSend++;
            }
        }

        entry.cursor = newCursor;

        if (
            (retrievalAmount != null && entry.retrievalAmount <= 0) ||
            Object.keys(updates).length === 0 ||
            newCursor >= gameUpdatesIDs.length
        ) {
            delete tempMap[requestID];
            hasMore = false;
        }

        res.send({ updates: updatesChunk, hasMore });
    } catch (err) {
        console.error(err);
        res.sendStatus(500);
    }
});

// app.post('/api/game-updates-for-owned-games', ensureAuthenticated, async (req, res) => {
//     const appids = (req.body.appids ?? []).map(appid => parseInt(appid, 10));
//     const updates = []; // An array of {appid: appid, events: []} in order of most recently updated
//     // Iterate through all passed in games and add them if found
//     for (const appid of appids) {
//         // (The appid is the second element in the array)
//         // const events = app.locals.allSteamGamesUpdates[appid];
//         const events = await getSingleRedisValue(appid);
//         if (events == null || app.locals.allSteamGamesUpdatesPossiblyChanged[appid] > (events[0]?.posttime ?? 0)) {
//             // Games that have been updated recently are more likely to have new updates, so prioritize based on last updated
//             app.locals.appidsToCheckPriorityQueue.enqueue(appid, events?.[0]?.posttime);
//         }
//         updates.push(
//             {
//                 appid: appid,
//                 events,
//             }
//         );
//     }
//     res.send({ updates });
// });

app.get('/api/game-details', ensureAuthenticated, async (req, res) => {
    if (req.app.locals.waitBeforeRetrying === false && req.app.locals.dailyLimit > 0) {
        let result = null;
        const appid = req.query.appid;
        if (app.locals.steamGameDetails[appid] == null) {
            await app.locals.requestQueue.add(
                makeRequest(`https://store.steampowered.com/api/appdetails?appids=${appid}`),
                { priority: 1000 }   // Make sure this request is processed immediately
            )
                .then(response => result = response?.data)
                .catch(err => console.error(`Getting the game ${appid}'s details failed.`, err));
            // Since we bothered to get this game's details, let's hold on to them...
            const { name, header_image, capsule_image, capsule_imagev5 } = result?.[appid]?.data ?? {};
            app.locals.steamGameDetails[appid] = {
                name,
                header_image,
                capsule_image,
                capsule_imagev5,
            };
        }
        res.send(app.locals.steamGameDetails[appid]);
        app.locals.dailyLimit--;
    } else {
        const errMsg = `The limit for requests has been reached: retry later ${req.app.locals.waitBeforeRetrying}, daily limit ${req.app.locals.dailyLimit}`;
        console.error(errMsg)
        res.status(400).send(new Error(errMsg));
    }
});

app.get('/api/login', function (req, res) {
    res.redirect('/api/auth/steam');
});

app.post('/api/logout', function (req, res) {
    if (req.isAuthenticated()) {
        req.logout({}, () => { });
    } else if (app.locals.mobileSessions[req.headers['session-id']] != null) {
        delete app.locals.mobileSessions[req.headers['session-id']];
    }

    notificationUnsubscribe(req);
    res.sendStatus(200);
});

app.post('/api/notification/unsubscribe', ensureAuthenticated, function (req, res) {
    try {
        notificationUnsubscribe(req);
        res.sendStatus(200);
    } catch (err) {
        console.error('Error unsubscribing from notifications:', err);
        res.status(500).send(new Error('Failed to unsubscribe from notifications'));
    }
});

app.post('api/notification/subscribe', ensureAuthenticated, async (req, res) => {
    try {
        notificationSubscribe(req);
        res.sendStatus(200);
    } catch (err) {
        console.error('Error subscribing to notifications:', err);
        res.status(500).send(new Error('Failed to subscribe to notifications'));
    }
});

app.get('/api/login/ios', function (req, res) {
    res.redirect(`/api/auth/steam?redirect_uri=${req.query.redirect_uri}&state=${req.query.state}`,);
});

// app.post('/api/logout/ios', function (req, res) {
//     const id = req.query.id;
//     app.locals.mobileSessions.delete(id);
//     res.sendStatus(200);
// });

// GET /auth/steam
//   Use passport.authenticate() as route middleware to authenticate the
//   request.  The first step in Steam authentication will involve redirecting
//   the user to steamcommunity.com.  After authenticating, Steam will redirect the
//   user back to this application at /auth/steam/return
app.get('/api/auth/steam', (req, res, next) => {
    const { redirect_uri, state } = req.query
    if (redirect_uri) {
        req.session.oauthRedirectUri = redirect_uri;
        req.session.state = state;
        // req.session.save();
    }
    const authenticator = passport.authenticate('steam', { state, failureRedirect: '/error', });
    authenticator(req, res, next)
});

// GET /api/auth/steam/return
//   Use passport.authenticate() as route middleware to authenticate the
//   request.  If authentication fails, the user will be redirected back to the
//   login page.  Otherwise, the primary route function function will be called,
//   which, in this example, will redirect the user to the home page.
app.get('/api/auth/steam/return',
    passport.authenticate('steam', { failureRedirect: '/error' }),
    function (req, res) {
        const redirect_uri = req.user?.redirect_uri;
        const state = req.user?.state;
        if (redirect_uri && state) {
            delete req.user.redirect_uri;
            delete req.user.state;
            const user = encodeURIComponent(JSON.stringify(req.user))
            const sessionID = uuidv4().toString();
            addSession(sessionID, { id: user.id });
            res.redirect(`${redirect_uri}?user=${user}&state=${state}&sessionID=${sessionID}`);
        } else {
            res.redirect('/close');
        }
    });

const httpServer = createServer(app);
httpServer.on('upgrade', (request, socket, head) => {
    // Use the Express session middleware to parse the session from the request.
    sessionMiddleware(request, {}, () => {
        // Check if the user is authenticated via Passport.js
        // The passport user object is stored in the session.
        const urlParts = url.parse(request.url, true);
        const sessionID = urlParts.query['session-id'];

        if ((request.session.passport && request.session.passport.user)
            || (sessionID != null && app.locals.mobileSessions[sessionID] != null)
        ) {
            const clientIP = request.headers['x-forwarded-for'] || request.socket.remoteAddress;
            if (request.session.passport) {
                const user = request.session.passport.user;
                console.log(`\nSteam user ${user.displayName} (ID: ${user.id}) connected from ${clientIP} to WebSocket.\n`);
            } else {
                console.log(`\nClient connected from ${clientIP} to WebSocket.\n`);
            }

            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        } else {
            // If no valid session or authentication is found, deny the connection.
            console.log('\nAuthentication failed during WebSocket upgrade. Connection denied.\n');
            socket.destroy();
        }
    });
});
httpServer.listen(PORT, () => {
    console.log(`server listening on port ${PORT}`);
});

// app.listen(PORT, () => {
//     console.log(`server listening on port ${PORT}`);
// });

// For now NGINX handles the secure connection to the outside world
// if (environment === 'development') {
//     app.listen(PORT, () => {
//         console.log(`server listening on port ${PORT}`);
//     });
// } else {
//     const options = {
//         key: fs.readFileSync(config.SSL_KEY_PATH),
//         cert: fs.readFileSync(config.SSL_CERT_PATH),
//     };
//     console.log(`server listening on port ${PORT}`);
//     createServer(options, app).listen(PORT);
// }
