import axios from 'axios';
import { execSync, fork, spawn } from 'child_process';
import cors from 'cors';
import express from 'express';
import session from 'express-session';
import fs from 'fs';
import PQueue from 'p-queue';
import passport from 'passport';
import SteamStrategy from 'passport-steam';
// import SteamStrategy from 'modern-passport-steam';
// import { createServer } from 'https';
import path from 'path';
import pidusage from 'pidusage';
import sessionfilestore from 'session-file-store';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import WebSocket, { WebSocketServer } from 'ws';

import config from '../../config.js';
import { PriorityQueue, webSocketConnectWithRetry } from '../utilities/utils.js';

const environment = config.ENVIRONMENT || 'development'; // Default to 'development' if not set

const __filename = fileURLToPath(import.meta.url);  // get the resolved path to the file
const __dirname = path.dirname(__filename);         // get the name of the directory

if (environment !== 'development') {
    try {
        console.log('Running cleanup script before starting server...');
        execSync('bash ./cleanup.sh', { stdio: 'inherit' });
        console.log('Cleanup complete.');
    } catch (error) {
        console.error('Cleanup script failed:', error);
        // Decide if you want to exit or continue here
        // process.exit(1);
    }
} else {
    console.clear();
}

// Spin up SteamWebPipes server
const MEMORY_LIMIT_MB = 100;
const MEMORY_LIMIT_BYTES = MEMORY_LIMIT_MB * 1024 * 1024;
const MONITOR_INTERVAL_MS = 15000; // Check every 15 seconds

let steamWepPipesProcess = null
let ws = null;
function initializeSteamWebPipes() {
    steamWepPipesProcess = spawn(path.join(__dirname, '../../SteamWebPipes-master/bin/SteamWebPipes'));
    // SteamWebPipes WebSocket setup
    do {
        console.log('Connecting to SteamWebPipes server...');
        ws = webSocketConnectWithRetry({
            url: 'ws://localhost:8181',
            socketType: 'server',
            isDev: environment === 'development'
        });
    } while (ws == null);

    ws.on('open', () => {
        console.log('Connected to SteamWebPipes server');
    });

    // START SteamWebPipes WebSocket connection
    // Keep track of what has POSSIBLY changed from PICS
    ws.on('message', (message) => {
        const { Apps: apps } = JSON.parse(message);
        if (apps == null) {
            return;
        }
        // broadcast the PICS update message to all connected clients
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    apps
                }));
            }
        });
        const appids = Object.keys(apps);
        for (const appid of appids) {
            app.locals.allSteamGamesUpdatesPossiblyChanged[appid] = new Date().getTime();
        }
    });

    ws.on('close', () => {
        console.log('Disconnected from SteamWebPipes server');
    });

    ws.on('error', (error) => {
        console.error('SteamWebPipes error:', error);
    });
    // END SteamWebPipes WebSocket connection
}
initializeSteamWebPipes();

setInterval(() => {

    if (steamWepPipesProcess?.exitCode == null && steamWepPipesProcess.signalCode == null) {
        pidusage(steamWepPipesProcess.pid)
            .then(stats => {
                // stats.memory is in bytes (RSS - Resident Set Size)
                const memoryMB = stats.memory / (1024 * 1024);
                console.log(`SteamWebPipes process (PID: ${steamWepPipesProcess.pid}) memory usage: ${memoryMB.toFixed(2)} MB`);

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

const DAILY_LIMIT = 200000;
const RETRY_WAIT_TIME = 5 * 60 * 1000;      // Time in minutes
const REQUEST_WAIT_TIME = 500;              // 864 would keep within 100k a day, but it appears there is no limit on updates
const NUMBER_OF_REQUESTS_PER_WAIT_TIME = 1; // Number of requests to allow per REQUEST_WAIT_TIME

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

const allSteamGameUpdatesDirectoryPath = path.join(__dirname, './storage/all-steam-game-updates');
if (!fs.existsSync(allSteamGameUpdatesDirectoryPath)) {
    try {
        fs.mkdirSync(allSteamGameUpdatesDirectoryPath, { recursive: true });
        console.log(`Directory '${allSteamGameUpdatesDirectoryPath}' created successfully.`);
    } catch (err) {
        console.error('Error creating directory. Must abort application and fix - check permissions.', err);
        process.exit(1);
    }
}
// End storage folders.

let gameUpdatesFromFile = {};   // {[appid]: events[]}
fs.readdirSync(allSteamGameUpdatesDirectoryPath).forEach(fileName => {
    if (path.extname(fileName) === '.json') {
        try {
            const result =
                fs.readFileSync(path.join(__dirname, `./storage/all-steam-game-updates/${fileName}`),
                    { encoding: 'utf8', flag: 'r' }) || '{}';
            const parsedResult = JSON.parse(result);
            gameUpdatesFromFile = { ...gameUpdatesFromFile, ...parsedResult };
        } catch (e) {
            console.error(`failure reading file ${fileName}.json`);
        }
    }
});
const allSteamGamesUpdatesPossiblyChangedFromFile = fs.existsSync(path.join(__dirname, './storage/allSteamGamesUpdatesPossiblyChanged.json')) ?
    fs.readFileSync(path.join(__dirname, './storage/allSteamGamesUpdatesPossiblyChanged.json'), { encoding: 'utf8', flag: 'r' })
    : '{}';    // {[appid]: POSSIBLE most recent update time}
const gameIDsWithErrors = fs.existsSync(path.join(__dirname, './storage/gameIDsWithErrors.json')) ?
    fs.readFileSync(path.join(__dirname, './storage/gameIDsWithErrors.json'), { encoding: 'utf8', flag: 'r' })
    : '[]';    // [appid]
const gameIDsToCheckIndex = fs.existsSync(path.join(__dirname, './storage/gameIDsToCheckIndex.json')) ?
    fs.readFileSync(path.join(__dirname, './storage/gameIDsToCheckIndex.json'), { encoding: 'utf8', flag: 'r' })
    : '0';     // For incrementing through ALL steam games - ~ 100k requests/day
const steamGameDetails = fs.existsSync(path.join(__dirname, './storage/steamGameDetails.json')) ?
    fs.readFileSync(path.join(__dirname, './storage/steamGameDetails.json'), { encoding: 'utf8', flag: 'r' })
    : '{}';    // {[appid]: {name, img_icon_url, img_logo_url, ...}}
const serverRefreshTimeAndCount = fs.existsSync(path.join(__dirname, './storage/serverRefreshTimeAndCount.json')) ?
    fs.readFileSync(path.join(__dirname, './storage/serverRefreshTimeAndCount.json'), { encoding: 'utf8', flag: 'r' })
    : JSON.stringify([new Date().getTime(), DAILY_LIMIT]); // Last time the server was refreshed (i.e. daily limit reset) and the last recorded daily limit
const mobileSessions = fs.existsSync(path.join(__dirname, './storage/mobileSessions.json')) ?
    fs.readFileSync(path.join(__dirname, './storage/mobileSessions.json'), { encoding: 'utf8', flag: 'r' })
    : '[]';    // [ sessionID-1, sessionID-2, ... ]
const userOwnedGames = environment === 'development' &&
    fs.existsSync(path.join(__dirname, './storage/userOwnedGames.json')) ?
    fs.readFileSync(path.join(__dirname, './storage/userOwnedGames.json'), { encoding: 'utf8', flag: 'r' })
    : '{}';

const app = express();
app.locals.requestQueue = new PQueue({ interval: REQUEST_WAIT_TIME, intervalCap: NUMBER_OF_REQUESTS_PER_WAIT_TIME });
app.locals.gameIDsToCheckPriorityQueue = new PriorityQueue();

function makeRequest(url, method = 'get') {
    return async () => {
        return axios[method](url);
    }
};

// https://stackoverflow.com/questions/33030092/webworkers-with-a-node-js-express-application
async function getAllSteamGameNames() {
    return app.locals.requestQueue.add(
        makeRequest('https://api.steampowered.com/ISteamApps/GetAppList/v0002/')
    ).then((result) => {
        // disregard apps without a name
        let games = result.data.applist.apps.filter(app => app.name !== '');//.sort((a, b) => a.appid - b.appid);
        const gameHash = games.reduce((acc, game) => {
            acc[game.appid] = game.name;
            return acc;
        }, {});
        // Remove appid duplicates that can be present in the returned list
        // This isn't ideal, but it appears to be the most efficient way to do this, and is pretty fast.
        games = Array.from(new Set(games.map(a => a.appid)));
        games = games.map((appid) => ({
            appid,
            name: gameHash[appid]
        }));
        console.log(`Server has retrieved ${games.length} games`);
        return games;
    }).catch(err => {
        console.error('Retrieving all games from Steam API failed.', err);
    })
}

app.locals.allSteamGames = await getAllSteamGameNames();
app.locals.allSteamGamesUpdates = gameUpdatesFromFile;
app.locals.steamGameDetails = JSON.parse(steamGameDetails);
app.locals.allSteamGamesUpdatesPossiblyChanged = JSON.parse(allSteamGamesUpdatesPossiblyChangedFromFile);
app.locals.gameIDsToCheckIndex = parseInt(JSON.parse(gameIDsToCheckIndex));
app.locals.gameIDsWithErrors = new Set(JSON.parse(gameIDsWithErrors));
app.locals.userOwnedGames = environment === 'development' ? JSON.parse(userOwnedGames) : null;
app.locals.waitBeforeRetrying = false;
const [lastStartTime, lastDailyLimitUsage = 0] = JSON.parse(serverRefreshTimeAndCount);
app.locals.dailyLimit = lastDailyLimitUsage;
app.locals.lastServerRefreshTime = lastStartTime ?? new Date().getTime();
// Since passport isn't properly tracking mobile sessions, we need to track them ourselves.
// We generate our own UUIDs to check against for the mobile app.
app.locals.mobileSessions = new Set(JSON.parse(mobileSessions));

const ensureAuthenticated = function (req, res, next) {
    if (req.isAuthenticated() || app.locals.mobileSessions.has(req.headers['session-id'])) {
        return next();
    }
    console.error('User is not authenticated:',
        req.user, req.headers['session-id'],
        app.locals.mobileSessions.has(req.headers['session-id']));
    res.sendStatus(401);
}

async function getGameIDUpdates(
    gameID,
    prioritizedRequest = false,
    includeCountBefore = true,
    includeCountAfter = true
) {
    let result = null;
    if (gameID == null) {
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
                    `?appid=${gameID}` +
                    (includeCountBefore ? '&count_before=0' : '') +
                    (includeCountAfter ? '&count_after=100' : '')),
                { priority: prioritizedRequest ? 2 : 0 }
            );
        result = response.data;
    } catch (err) {
        console.error(`Getting the game ${gameID}'s updates failed.`, err.message, '\n', err.response?.status, '\n', err.response?.data,);
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
            console.log(`Retrying ${gameID} request with shouldIncludeCountBefore:` +
                `${shouldIncludeCountBefore}, shouldIncludeCountAfter: ${shouldIncludeCountAfter}`)
            // retry in this order, after using both params failed:
            // 1. Try with count_before as false, but count_after is true.
            // 2. If #1 fails, then try with count_before being true, and count_after as false.
            // 3. If #2 fails try both as false.
            // 4. If that fails then give up.
            return getGameIDUpdates(
                gameID,
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
console.log(`Server has loaded up ${Object.keys(app.locals.allSteamGamesUpdates).length} games with their updates.`);

// START Steam Game Updates WebSocket connection
const webSocketServerOptions = { port: 8081 };
// For now NGINX handles the secure connection to the outside world
// if (environment !== 'development') {
//     webSocketServerOptions.server = createServer({
//         key: fs.readFileSync(config.SSL_KEY_PATH),
//         cert: fs.readFileSync(config.SSL_CERT_PATH),
//     });
// }
const wss = new WebSocketServer(webSocketServerOptions);
wss.on('connection', function connection(ws) {
    console.log('WebSocket connection established with a client');
    ws.on('error', console.error);
    ws.on('close', () => {
        console.log('Client disconnected');
    });
});
// END Steam Game Updates WebSocket connection

// https://steamcommunity.com/dev/apiterms#:~:text=any%20Steam%20game.-,You%20may%20not%20use%20the%20Steam%20Web%20API%20or%20Steam,Steam%20Web%20API%20per%20day.
// Reset the daily limit every 24 hours
// Initial Daily Limit Interval must respect previous start time, so start with Timeout
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
setTimeout(() => {
    app.locals.dailyLimit = DAILY_LIMIT;
    app.locals.lastServerRefreshTime = new Date().getTime();

    setTimeout(() => {
        app.locals.dailyLimit = DAILY_LIMIT;
        app.locals.lastServerRefreshTime = new Date().getTime();
    }, getNextMidnight());
}, getNextMidnight());

// Log out all users every 2 days.
// Maybe make this longer in the future.
setInterval(() => {
    // crude, but will prevent stale sessions from piling up
    // TODO: in the future keep track of how old a session is before removing
    app.locals.mobileSessions = new Set();
    const dir = path.join(__dirname, './storage/passport-sessions')
    fs.readdirSync(dir).forEach(f => fs.rmSync(`${dir}/${f}`));
}, (1000 * 60 * 60 * 24) * 22);    // Set a new interval of 24 hours

// Refresh all games every hour
// At this point it's not cleared/guaranteed that the games will always come back in the
// same order, but it appears to be the case, at least for now.
setInterval(async () => {
    console.log('Refreshing all games');
    if (app.locals.dailyLimit > 0 && app.locals.waitBeforeRetrying === false) {
        getAllSteamGameNames().then(allGames => {
            app.locals.dailyLimit--;
            if (allGames) {
                app.locals.allSteamGames = allGames;
            } else {
                app.locals.waitBeforeRetrying = true;
                setTimeout(() => app.locals.waitBeforeRetrying = false, RETRY_WAIT_TIME);
            }
        });
    }
}, 60 * 60 * 1000)

const getGameUpdates = async (externalGameID) => {
    if (app.locals.dailyLimit > 0
        && app.locals.waitBeforeRetrying === false) {

        const priorityGameID = app.locals.gameIDsToCheckPriorityQueue.dequeue();
        if (externalGameID != null) {
            console.log('External gameID:', externalGameID, app.locals.gameIDsToCheckPriorityQueue.size());
        } else if (priorityGameID != null) {
            console.log('Priority gameID:', priorityGameID, app.locals.gameIDsToCheckPriorityQueue.size());
        }

        let gameID = externalGameID ?? priorityGameID
            ?? app.locals.allSteamGames[app.locals.gameIDsToCheckIndex]?.appid;
        if (gameID == null) {
            app.locals.gameIDsToCheckIndex = 0; // Loop back to the beginning
            gameID = app.locals.allSteamGames[0].appid;
        }

        // Skip the gameID if it has already been checked and failed, and this wasn't a manual request.
        if (app.locals.gameIDsWithErrors.has(gameID) && !externalGameID && !priorityGameID) {
            app.locals.gameIDsToCheckIndex++;
        } else {
            //  If a user has requested a sspecific gameID we need to process it asap.
            const result = await getGameIDUpdates(gameID, !!externalGameID);
            app.locals.dailyLimit--;

            if (result.success === 1) {
                // Only increment the index if this was not a manual request.
                if (externalGameID == null && priorityGameID == null) {
                    app.locals.gameIDsToCheckIndex++;
                }

                // To keep track of the most recent 10 updates - .slice(0, 10)
                const mostRecentEvents = result.events.map(event => {
                    const { posttime, body, gid, headline } = event.announcement_body;
                    return { posttime, body, gid, headline, event_type: event.event_type };
                });
                const mostRecentEventTime = (mostRecentEvents[0]?.posttime ?? 0) * 1000;
                const mostRecentPreviouslyKnownEventTime = (app.locals.allSteamGamesUpdates[gameID]?.[0]?.posttime ?? 0) * 1000;
                // Since we just got the most recent updates, this can be set to that event's post time.
                app.locals.allSteamGamesUpdatesPossiblyChanged[gameID] =
                    Math.max(mostRecentEventTime, mostRecentPreviouslyKnownEventTime);

                app.locals.allSteamGamesUpdates[gameID] = mostRecentEvents;
                if (mostRecentEvents.length > 0 && mostRecentPreviouslyKnownEventTime < mostRecentEventTime) {
                    // let clients know a new update has been processed
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                appid: gameID,
                                eventsLength: app.locals.allSteamGamesUpdates[gameID]?.length,
                                // mostRecentUpdateTime
                            }));
                        }
                    });
                }
                console.log(`Getting the game ${gameID}'s updates completed with ${app.locals.allSteamGamesUpdates[gameID]?.length ?? 0} event(s), with ${DAILY_LIMIT - app.locals.dailyLimit} requests so far.`);
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
                // This gameID has not been found for whatever reason, so don't try it again.
                app.locals.gameIDsWithErrors.add(gameID);
                // Only increment the index if this was not a manual request.
                if (externalGameID == null && priorityGameID == null) {
                    app.locals.gameIDsToCheckIndex++;
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
// Save the results every five minute so we don't lose them if the server restarts/crashes.
// Write to file for now, but future optimization could be to use something like mongo db.
setInterval(async () => {
    // We may as well stop saving the files if the daily limit is 0 so we don't keep writing
    // the same data over and over again.
    if (app.locals.dailyLimit > -2 && fileWriterProcess == null) {
        // Save once after the daily limit is reached, then stop.
        if (app.locals.dailyLimit === -1) {
            app.locals.dailyLimit = -2;
        }

        const fileWriterSend = initializeFileWriterProcess(); // Initialize the child process on server start
        const entries = Object.entries(app.locals.allSteamGamesUpdates);
        const chunkSize = 1000;
        try {
            for (let i = 0; i < entries.length; i += chunkSize) {
                const nextChunk = i + chunkSize;
                const subsetOfGames = entries.slice(i, nextChunk);
                const chunk = Object.fromEntries(subsetOfGames)
                const filename = `allSteamGamesUpdates-${nextChunk}.json`;
                await fileWriterSend({
                    type: 'writeFile',
                    payload: {
                        filename,
                        data: chunk,
                        directory: path.join(__dirname, './storage/all-steam-game-updates')
                    }
                });
            }
            await fileWriterSend({
                type: 'writeFile',
                payload: {
                    filename: './storage/gameIDsWithErrors.json',
                    data: Array.from(app.locals.gameIDsWithErrors),
                }
            });

            await fileWriterSend({
                type: 'writeFile',
                payload: {
                    filename: './storage/gameIDsToCheckIndex.json',
                    data: (app.locals.gameIDsToCheckIndex || 0).toString(),
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
                    data: Array.from(app.locals.mobileSessions),
                }
            });
            if (environment === 'development' && app.locals.userOwnedGames) {
                await fileWriterSend({
                    type: 'writeFile',
                    payload: {
                        filename: './storage/userOwnedGames.json',
                        data: app.locals.userOwnedGames,
                    }
                });
            }
        } catch (err) {
            if (err) {
                console.error('Error writing to files occurred...', err);
            }
        }
        fileWriterProcess.kill();
    }
}, 30 * 60 * 1000);

const FileStore = sessionfilestore(session);
const sessionOptions = {
    secret: config.STEAM_GAME_UPDATES_SECRET,
    name: 'steam-game-updates',
    resave: false,
    saveUninitialized: true,
    store: new FileStore({                                          // Use FileStore as the session store
        path: path.join(__dirname, './storage/passport-sessions'),  // Specify the directory to store session files
        ttl: 60 * 60 * 24 * 2,                                      // Set the time to live for sessions to 2 days
    })
};
if (environment !== 'development') {
    sessionOptions.cookie = {
        sameSite: 'none',  // Required for cross-site requests
        secure: true,      // Must be true when sameSite is 'none'
        httpOnly: true,    // Recommended for security
    };
}
app.use(session(sessionOptions));
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
        const useLocal = req.query.use_local === 'true';
        // If we just want to use what has been retrieved previously so as not to constantly hit
        // Steam's API:
        if (useLocal && environment === 'development') {
            console.log(`Using locally stored games for user ${userID}; sending ${app.locals.userOwnedGames[userID]?.length ?? 0} games`);
            return res.send({ games: app.locals.userOwnedGames[userID] });
        }

        //  If a user has requested their games we need to process it asap.
        await app.locals.requestQueue.add(
            makeRequest(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${config.STEAM_API_KEY}&steamid=${userID}&include_appinfo=true&skip_unvetted_apps=true`),
            { priority: 3 }   // Prioritize this request above all others
        )
            .then(response => { result = response })
            .catch(err => {
                console.error(`\nGetting the user ${req.query.id}'s owned games FAILED with code "${err.response?.status}"`
                    + ` and message "${err.response.statusText} (no code means the server didn't responsd).\n`, err);
                app.locals.waitBeforeRetrying = true;
                setTimeout(() => app.locals.waitBeforeRetrying = false, err.response.retryAfter != null ? err.response.retryAfter * 1000 : RETRY_WAIT_TIME);
            });
        app.locals.dailyLimit--;
        console.log(`Getting the user ${req.query.id}'s owned games completed with ${result.data?.response?.game_count ?? 'no'} games`);
        if (environment === 'development') {
            app.locals.userOwnedGames[userID] = result.data?.response?.games ?? [];
        }
        res.send(result.data?.response);
    } else {
        res.status(400).send(new Error(`The limit for requests has been reached: retry later ${req.app.locals.waitBeforeRetrying}, daily limit ${req.app.locals.dailyLimit}`));
    }
});

app.get('/api/all-steam-games', ensureAuthenticated, async (req, res) => {
    res.send(req.app.locals.allSteamGames);
});

app.get('/api/update-queue', ensureAuthenticated, async (req, res) => {
    res.send(req.app.locals.allSteamGames);
});

app.post('/api/game-updates', ensureAuthenticated, async (req, res) => {
    const gameID = req.query.appid;
    app.locals.gameIDsToCheckPriorityQueue.enqueue(gameID, 100); // Give this request a high priority
    res.sendStatus(200);
    // This is part of the code that can trigger automatic updates on the client side.
    // possibly from a GET route that could be implemented.
    // if (!req.app.locals.gameIDsWithErrors.has(gameID)) {
    //     await getGameUpdates(gameID);
    // }
    // if (app.locals.gameIDsWithErrors.has(gameID)) {
    //     res.send([]);   // This game doesn't have updates
    // } else {
    //     res.send(app.locals.allSteamGamesUpdates[gameID]);
    // }
});

const tempMap = {};
// create a temp map entry with the UUID from POST
// lookup all entries and then store in map
// create a GET endpoint that returns paginated results
// once the end is reached, delete the temp map entry

app.post('/api/beta/game-updates-for-owned-games', ensureAuthenticated, async (req, res) => {
    const gameIDs = Object.values(req.body.appids ?? {}).map(gameID => parseInt(gameID));
    const requestID = req.body.request_id;
    if (requestID == null) {
        res.sendStatus(406);
        return;
    }
    const updates = {}; // {appid: gameID, events: []}
    // Iterate through all passed in games and add them if found
    for (const gameID of gameIDs) {
        // (The gameID is the second element in the array)
        const events = app.locals.allSteamGamesUpdates[gameID];
        if (events == null || app.locals.allSteamGamesUpdatesPossiblyChanged[gameID] > (events[0]?.posttime * 1000 ?? 0)) {
            // Games that have been updated recently are more likely to have new updates, so prioritize based on last updated
            app.locals.gameIDsToCheckPriorityQueue.enqueue(gameID, events?.[0]?.posttime);
        }
        if (events != null) {
            updates[gameID] = events;
        }
    }
    let gameUpdatesIDs = [];
    // Sort the updates for each game by posttime, descending
    for (const [appid, events] of Object.entries(updates)) {
        gameUpdatesIDs = gameUpdatesIDs.concat(
            events.map(({ posttime }) => [posttime, appid]));
    }
    gameUpdatesIDs = gameUpdatesIDs.sort((a, b) => b[0] - a[0]);
    tempMap[requestID] = { updates, gameUpdatesIDs }
    res.send({ gameUpdatesIDs });
});

app.get('/api/beta/game-updates-for-owned-games', ensureAuthenticated, async (req, res) => {
    const requestID = req.query.request_id;
    const requestSize = parseInt(req.query.fetch_size ?? '150');
    let updatesChunk = {};

    try {
        let appsFound = 0;
        while (appsFound < requestSize
            && Object.keys(tempMap[requestID].updates).length > 0) {
            // find the next requestSize (e.g. 150) # of unsent games to return to client
            for (const [index, [, appid]] of tempMap[requestID].gameUpdatesIDs.entries()) {
                if (tempMap[requestID].updates[appid] != null
                    && updatesChunk[appid] == null) {
                    updatesChunk[appid] = tempMap[requestID].updates[appid];
                    delete tempMap[requestID].updates[appid];
                    appsFound++;
                    break;
                }
                // If the entire updates array didn't have any remaining games in it,
                // then those remaining games have no updates to report, so we're done.
                if (index === tempMap[requestID].gameUpdatesIDs.length - 1) {
                    appsFound = Infinity;
                }
            }
        }

        let hasMore = true;
        if (Object.keys(tempMap[requestID].updates).length === 0
            || appsFound === Infinity) {
            delete tempMap[requestID];
            hasMore = false;
        }
        res.send({ updates: updatesChunk, hasMore })
    } catch {
        res.sendStatus(404);
    }
});

app.post('/api/game-updates-for-owned-games', ensureAuthenticated, async (req, res) => {
    const gameIDs = Object.values(req.body.appids ?? {}).map(gameID => parseInt(gameID, 10));
    const updates = []; // An array of {appid: gameID, events: []} in order of most recently updated
    // Iterate through all passed in games and add them if found
    for (const gameID of gameIDs) {
        // (The gameID is the second element in the array)
        const events = app.locals.allSteamGamesUpdates[gameID];
        if (events == null || app.locals.allSteamGamesUpdatesPossiblyChanged[gameID] > (events[0]?.posttime * 1000 ?? 0)) {
            // Games that have been updated recently are more likely to have new updates, so prioritize based on last updated
            app.locals.gameIDsToCheckPriorityQueue.enqueue(gameID, events?.[0]?.posttime);
        }
        updates.push(
            {
                appid: gameID,
                events: app.locals.allSteamGamesUpdates[gameID],
            }
        );
    }
    res.send({ updates });
});

app.post('/api/game-update-ids-for-owned-games', ensureAuthenticated, async (req, res) => {
    const gameIDs = Object.values(req.body.appids ?? {}).map(gameID => parseInt(gameID));
    const lastCheckTime = parseInt(req.query.last_check_time)   // this is ms
    const gameIDsWithUpdates = [];
    // Iterate through all passed in games and add them if found
    for (const gameID of gameIDs) {
        const events = app.locals.allSteamGamesUpdates[gameID];
        if (events == null || app.locals.allSteamGamesUpdatesPossiblyChanged[gameID] > (events[0]?.posttime * 1000 ?? 0)) {
            app.locals.gameIDsToCheckPriorityQueue.enqueue(gameID, events?.[0]?.posttime);
        }

        const mostRecentUpdateTime =
            Math.max((app.locals.allSteamGamesUpdatesPossiblyChanged[gameID] ?? 0), (events?.[0]?.posttime * 1000 ?? 0))
        if (events != null && mostRecentUpdateTime > lastCheckTime) {
            // We know for sure that there has been some activity since the client last checked
            gameIDsWithUpdates.push(gameID);
        }
    }
    res.send({ gameIDsWithUpdates });
});

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
            const { name, header_image, capsule_image, capsule_imagev5 } = result[appid]?.data ?? {};
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
    } else if (app.locals.mobileSessions.has(req.headers['session-id'])) {
        app.locals.mobileSessions.delete(req.headers['session-id']);
    }
    res.sendStatus(200);
});

app.get('/api/login/ios', function (req, res) {
    res.redirect(`/api/auth/steam?redirect_uri=${req.query.redirect_uri}&state=${req.query.state}`,);
});

app.post('/api/logout/ios', function (req, res) {
    const id = req.query.id;
    app.locals.mobileSessions.delete(id);
    res.sendStatus(200);
});

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
            app.locals.mobileSessions.add(sessionID);
            res.redirect(`${redirect_uri}?user=${user}&state=${state}&sessionID=${sessionID}`);
        } else {
            res.redirect('/close');
        }
    });

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`server listening on port ${PORT}`);
});

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
