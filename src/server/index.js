import axios from 'axios';
import { spawn } from 'child_process';
import cors from 'cors';
import express from 'express';
import session from 'express-session';
import fs from 'fs';
import PQueue from 'p-queue';
import passport from 'passport';
import SteamStrategy from 'passport-steam';
// import SteamStrategy from 'modern-passport-steam';
import { createServer } from 'https';
import path from 'path';
import sessionfilestore from 'session-file-store';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import WebSocket, { WebSocketServer } from 'ws';

import config from '../../config.js';
import { PriorityQueue, webSocketConnectWithRetry } from '../utilities/utils.js';

const environment = config.ENVIRONMENT || 'development'; // Default to 'development' if not set

const __filename = fileURLToPath(import.meta.url);  // get the resolved path to the file
const __dirname = path.dirname(__filename);         // get the name of the directory

console.clear();
// Spin up SteamWebPipes server
spawn(path.join(__dirname, '../../SteamWebPipes-master/bin/SteamWebPipes'));

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
    console.log('\n\nUser logged in:', identifier)
    // check for 'JSON response invalid, your API key is most likely wrong'
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

const DAILY_LIMIT = 100000;
const WAIT_TIME = 1000;                     // Space out requests to at most 1 request per second
const NUMBER_OF_REQUESTS_PER_WAIT_TIME = 1; // Number of requests to allow per WAIT_TIME

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
        const result =
            fs.readFileSync(path.join(__dirname, `./storage/all-steam-game-updates/${fileName}`),
                { encoding: 'utf8', flag: 'r' }) || '{}';
        const parsedResult = JSON.parse(result);
        gameUpdatesFromFile = { ...gameUpdatesFromFile, ...parsedResult };
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
app.locals.requestQueue = new PQueue({ interval: WAIT_TIME, intervalCap: NUMBER_OF_REQUESTS_PER_WAIT_TIME });
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
app.locals.gameIDsToCheck = app.locals.allSteamGames.map(game => game.appid);
app.locals.gameIDsToCheckIndex = parseInt(gameIDsToCheckIndex, 10);
app.locals.gameIDsWithErrors = new Set(JSON.parse(gameIDsWithErrors));
app.locals.userOwnedGames = environment === 'dev' ? JSON.parse(userOwnedGames) : null;
app.locals.waitBeforeRetrying = false;
const [lastStartTime, lastDailyLimitUsage = 0] = JSON.parse(serverRefreshTimeAndCount);
app.locals.dailyLimit = lastDailyLimitUsage - 200; // Playing it safe and always giving a buffer on startup of 200 less requests so as not to overwhelm the API
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
    res.sendStatus(429);
}

async function getGameIDUpdates(gameID, prioritizedRequest = false) {
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
                makeRequest(`https://store.steampowered.com/events/ajaxgetadjacentpartnerevents/?appid=${gameID}&count_before=0&count_after=100`),
                { priority: prioritizedRequest ? 2 : 0 }
            );
        result = response.data;
    } catch (err) {
        console.error(`Getting the game ${gameID}'s updates failed.`, err.message, '\n', err.response?.data);
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
if (environment !== 'development') {
    webSocketConnectWithRetry.server = createServer({
        key: fs.readFileSync(config.SSL_KEY_PATH),
        cert: fs.readFileSync(config.SSL_CERT_PATH),
    });
}
const wss = new WebSocketServer(webSocketServerOptions);
wss.on('connection', function connection(ws) {
    console.log('WebSocket connection established with a client');
    ws.on('error', console.error);
    ws.on('close', () => {
        console.log('Client disconnected');
    });
});
// END Steam Game Updates WebSocket connection

// SteamWebPipes WebSocket setup
let ws = null;
do {
    console.log('Connecting to SteamWebPipes server...');
    ws = webSocketConnectWithRetry('ws://localhost:8181', 3000, 'server');
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

// https://steamcommunity.com/dev/apiterms#:~:text=any%20Steam%20game.-,You%20may%20not%20use%20the%20Steam%20Web%20API%20or%20Steam,Steam%20Web%20API%20per%20day.
// Reset the daily limit every 24 hours
// Initial Daily Limit Interval must respect previous start time, so start with Timeout
setTimeout(() => {
    app.locals.dailyLimit = DAILY_LIMIT;
    app.locals.lastServerRefreshTime = new Date().getTime();

    setInterval(() => {
        app.locals.dailyLimit = DAILY_LIMIT;
        app.locals.lastServerRefreshTime = new Date().getTime();
    }, 1000 * 60 * 60 * 24);    // Set a new interval of 24 hours
}, (app.locals.lastServerRefreshTime + (1000 * 60 * 60 * 24)) - (new Date().getTime()));  // (lastStartTime + 24hrs) - currentTime

// Log out all users every 2 days.
// Maybe make this longer in the future.
setInterval(() => {
    // crude, but will prevent stale sessions from piling up
    // TODO: in the future keep track of how old a session is before removing
    app.locals.mobileSessions = new Set();
    const dir = path.join(__dirname, './storage/passport-sessions')
    fs.readdirSync(dir).forEach(f => fs.rmSync(`${dir}/${f}`));
}, (1000 * 60 * 60 * 24) * 22);    // Set a new interval of 24 hours

// Refresh all games every fifteen minutes
// At this point it's not cleared/guaranteed that the games will always come back in the
// same order, but it appears to be the case, at least for now.
setInterval(async () => {
    console.log('Refreshing all games');
    if (app.locals.dailyLimit > 0 && app.locals.waitBeforeRetrying === false) {
        getAllSteamGameNames().then(allGames => {
            app.locals.dailyLimit--;
            if (allGames) {
                app.locals.allSteamGames = allGames;
                app.locals.gameIDsToCheck = app.locals.allSteamGames.map(game => game.appid);
            } else {
                app.locals.waitBeforeRetrying = true;
                setTimeout(() => app.locals.waitBeforeRetrying = false, 60 * 5 * 1000);
            }
        });
    }
}, 15 * 60 * 1000)

const getGameUpdates = async (externalGameID) => {
    if (app.locals.dailyLimit > 0
        && app.locals.waitBeforeRetrying === false) {

        const priorityGameID = app.locals.gameIDsToCheckPriorityQueue.dequeue();
        if (externalGameID != null) {
            console.log('External gameID:', externalGameID, app.locals.gameIDsToCheckPriorityQueue.size());
        } else if (priorityGameID != null) {
            console.log('Priority gameID:', priorityGameID, app.locals.gameIDsToCheckPriorityQueue.size());
        }
        const gameID = externalGameID ?? priorityGameID
            ?? app.locals.gameIDsToCheck[app.locals.gameIDsToCheckIndex];

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
                const mostRecentEvents = result.events.map(event => event.announcement_body);
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
                console.log(`Getting the game ${gameID}'s updates completed with ${app.locals.allSteamGamesUpdates[gameID]?.length ?? 0} event(s), with ${app.locals.dailyLimit} requests left.`);
            } else if (result.status === 429 || result.status === 403) {
                if (result.status === 429 || result.retryAfter != null) {
                    app.locals.waitBeforeRetrying = true;
                    setTimeout(() => app.locals.waitBeforeRetrying = false, (result.retryAfter ?? 60 * 5) * 1000);
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
        if (app.locals.gameIDsToCheckIndex >= app.locals.gameIDsToCheck.length) {
            app.locals.gameIDsToCheckIndex = 0; // Loop back to the beginning
        }
    }

    if (app.locals.dailyLimit === 0) {
        app.locals.dailyLimit = -1; // Prevent message below from printing over and over.
        console.log(`Daily limit reached at ${new Date()}. Waiting for the next day to continue.`);
    }
}

// Continuously fetch game's updates every 1 second iterating over the gameIDsToCheck array.
// Constraint of 100000k allows for an average of one request every 0.86 seconds over 24 hours.
// Constraint of 200 per 5 minutes restricts to no more than one request every 1.5 seconds within any 5 - minute window.
// 200 constraint doesn't appear to affect this request...
setInterval(getGameUpdates, 1000);

// Save the results every minute so we don't lose them if the server restarts/crashes.
// Write to file for now, but future optimization could be to use something like mongo db.
setInterval(() => {
    // We may as well stop saving the files if the daily limit is 0 so we don't keep writing
    // the same data over and over again.
    if (app.locals.dailyLimit > -2) {
        // Save once after the daily limit is reached, then stop.
        if (app.locals.dailyLimit === -1) {
            app.locals.dailyLimit = -2;
        }
        // TODO: Need to put this into a folder and have multiple files. TODO
        const entries = Object.entries(app.locals.allSteamGamesUpdates);
        const chunkSize = 5000;
        try {
            for (let i = 0; i < entries.length; i += chunkSize) {
                const nextChunk = i + chunkSize;
                const subsetOfGames = entries.slice(i, nextChunk);
                const chunk = Object.fromEntries(subsetOfGames)
                const fileName = `allSteamGamesUpdates-${nextChunk}`;
                fs.writeFile(path.join(__dirname, `./storage/all-steam-game-updates/${fileName}.json`),
                    JSON.stringify(chunk), (err) => {
                        if (err) {
                            console.error(`Error writing to file ${fileName}.json`, err);
                        } else {
                            console.log(`File \`${fileName}.json\` written successfully`);
                        }
                    });
            }

            fs.writeFile(path.join(__dirname, './storage/gameIDsWithErrors.json'),
                JSON.stringify(Array.from(app.locals.gameIDsWithErrors)), (err) => {
                    if (err) {
                        console.error('Error writing to file gameIDsWithErrors.json', err);
                    } else {
                        console.log('File `gameIDsWithErrors.json` written successfully');
                    }
                });
            fs.writeFile(path.join(__dirname, './storage/gameIDsToCheckIndex.json'),
                app.locals.gameIDsToCheckIndex.toString(), (err) => {
                    if (err) {
                        console.error('Error writing to file gameIDsToCheckIndex.json', err);
                    } else {
                        console.log('File `gameIDsToCheckIndex.json` written successfully');
                    }
                });
            fs.writeFile(path.join(__dirname, './storage/allSteamGamesUpdatesPossiblyChanged.json'),
                JSON.stringify(app.locals.allSteamGamesUpdatesPossiblyChanged), (err) => {
                    if (err) {
                        console.error('Error writing to file allSteamGamesUpdatesPossiblyChanged.json', err);
                    } else {
                        console.log('File `allSteamGamesUpdatesPossiblyChanged.json` written successfully');
                    }
                });
            fs.writeFile(path.join(__dirname, './storage/serverRefreshTimeAndCount.json'),
                JSON.stringify([app.locals.lastServerRefreshTime, app.locals.dailyLimit]), (err) => {
                    if (err) {
                        console.error('Error writing to file serverRefreshTimeAndCount.json', err);
                    } else {
                        console.log('File `serverRefreshTimeAndCount.json` written successfully');
                    }
                });
            fs.writeFile(path.join(__dirname, './storage/steamGameDetails.json'),
                JSON.stringify(app.locals.steamGameDetails), (err) => {
                    if (err) {
                        console.error('Error writing to file steamGameDetails.json', err);
                    } else {
                        console.log('File `steamGameDetails.json` written successfully');
                    }
                });
            fs.writeFile(path.join(__dirname, './storage/mobileSessions.json'),
                JSON.stringify(Array.from(app.locals.mobileSessions)), (err) => {
                    if (err) {
                        console.error('Error writing to file mobileSessions.json', err);
                    } else {
                        console.log('File `mobileSessions.json` written successfully');
                    }
                });
            if (environment === 'development' && userOwnedGames) {
                fs.writeFile(path.join(__dirname, './storage/userOwnedGames.json'),
                    JSON.stringify(app.locals.userOwnedGames), (err) => {
                        if (err) {
                            console.error('Error writing to file userOwnedGames.json', err);
                        } else {
                            console.log('File `userOwnedGames.json` written successfully');
                        }
                    });
            }
        } catch (err) {
            if (err) {
                console.error('Error writing to files occurred...', err);
            }
        }
    }
}, 5 * 60 * 1000);

const FileStore = sessionfilestore(session);
app.use(session({
    secret: config.STEAM_GAME_UPDATES_SECRET,
    name: 'steam-game-updates',
    resave: false,
    saveUninitialized: true,
    store: new FileStore({                                          // Use FileStore as the session store
        path: path.join(__dirname, './storage/passport-sessions'),  // Specify the directory to store session files
        ttl: 60 * 60 * 24 * 2,                                      // Set the time to live for sessions to 2 days
    })
}));

// Initialize Passport and use passport.session() middleware to support persistent login sessions.
app.use(passport.initialize());
app.use(passport.session());
app.use(cors({
    origin: config.HOST_ORIGIN ?
        config.HOST_ORIGIN + (config.HOST_ORIGIN_PORT || ':3000') : 'https://steamgameupdates.info',
    methods: ['GET', 'POST'],
    credentials: true,          // Allow cookies to be sent with requests
    optionsSuccessStatus: 200   // some legacy browsers (IE11, various SmartTVs) choke on 204
}));

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

app.get('/api/user', (req, res) => {
    if (req.isAuthenticated() ||
        (req.headers['session-id'] != null && app.locals.mobileSessions.has(req.headers['session-id']))) {
        if (req.user == null) {
            res.sendStatus(200);
        } else {
            res.json(req.user);
        }
    } else {
        res.status(401).json({ message: 'Not authenticated' });
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
            makeRequest(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${config.STEAM_API_KEY}&steamid=${userID}&include_appinfo=true&skip_unvetted_apps=false`),
            { priority: 3 }   // Prioritize this request above all others
        )
            .then(response => { result = response })
            .catch(err => {
                console.error(`\nGetting the user ${req.query.id}'s owned games FAILED with code "${err.response?.status}"`
                    + ` and message "${err.response.statusText} (no code means the server didn't responsd).\n`, err);
                app.locals.waitBeforeRetrying = true;
                setTimeout(() => app.locals.waitBeforeRetrying = false, (err.response.retryAfter ?? 1000 * 60 * 5) * 1000);
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

app.get('/api/game-updates-for-owned-games', ensureAuthenticated, async (req, res) => {
    const gameIDs = Object.values(req.query.appids ?? {}).map(gameID => parseInt(gameID, 10));
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

app.get('/api/game-update-ids-for-owned-games', ensureAuthenticated, async (req, res) => {
    const gameIDs = Object.values(req.query.appids ?? {}).map(gameID => parseInt(gameID, 10));
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
        res.status(400).send(new Error(`The limit for requests has been reached: retry later ${req.app.locals.waitBeforeRetrying}, daily limit ${req.app.locals.dailyLimit}`));
    }
});

app.get('/api/login', function (req, res) {
    res.redirect('/auth/steam');
});

app.get('/api/logout', function (req, res) {
    req.logout({}, () => { });
    res.redirect('/close');
});

app.get('/api/login/ios', function (req, res) {
    res.redirect(`/auth/steam?redirect_uri=${req.query.redirect_uri}&state=${req.query.state}`,);
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
app.get('/auth/steam', (req, res, next) => {
    const { redirect_uri, state } = req.query
    if (redirect_uri) {
        req.session.oauthRedirectUri = redirect_uri;
        req.session.state = state;
        console.log('/auth/steam queries found:', req.session);
    }
    const authenticator = passport.authenticate('steam', { state, failureRedirect: '/error', });
    authenticator(req, res, next)
});

// GET /auth/steam/return
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
if (environment === 'development') {
    app.listen(PORT, () => {
        console.log(`server listening on port ${PORT}`);
    });
} else {
    const options = {
        key: fs.readFileSync(config.SSL_KEY_PATH),
        cert: fs.readFileSync(config.SSL_CERT_PATH),
    };

    createServer(options, (req, res) => {
        res.writeHead(200);
        console.log(`Prod secure server has started on port ${PORT}.`);
    }).listen(PORT);
}
