import axios from 'axios';
import { spawn } from 'child_process';
import cors from 'cors';
import express from 'express';
import session from 'express-session';
import useragent from 'express-useragent';
import fs from 'fs';
import PQueue from 'p-queue';
import passport from 'passport';
import { Strategy as SteamStrategy } from 'passport-steam';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import WebSocket, { WebSocketServer } from 'ws';

import config from '../../config.js';
import { PriorityQueue, webSocketConnectWithRetry } from '../utilities/utils.js';

const __filename = fileURLToPath(import.meta.url);  // get the resolved path to the file
const __dirname = path.dirname(__filename);         // get the name of the directory

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

// Use the SteamStrategy within Passport.
//   Strategies in passport require a `validate` function, which accept
//   credentials (in this case, an OpenID identifier and profile), and invoke a
//   callback with a user object.
passport.use(new SteamStrategy({
    returnURL: 'http://localhost:8080/auth/steam/return',
    realm: 'http://localhost:8080/',
    apiKey: config.STEAM_API_KEY,
    passReqToCallback: true
},
    function (req, identifier, profile, done) {
        // asynchronous verification, for effect...
        console.log('Steam profile received:', profile);
        process.nextTick(function () {
            // To keep the example simple, the user's Steam profile is returned to
            // represent the logged-in user.  In a typical application, you would want
            // to associate the Steam account with a user record in your database,
            // and return that user instead.
            profile.identifier = identifier;
            return done(null, profile);
        });
    }
));

const DAILY_LIMIT = 100000;   // should be 100k, but for testing purposes it's lower for now
const WAIT_TIME = 1000;     // Space out requests to at most 1 request per second
const NUMBER_OFREQUESTS_PER_WAIT_TIME = 1; // Number of requests to allow per WAIT_TIME

// TODO: This can reach 1.7GB in size, so need to examine storing it in multuple files...
const gameUpdatesFromFile = fs.existsSync(path.join(__dirname, './storage/allSteamGamesUpdates.json')) ?
    fs.readFileSync(path.join(__dirname, './storage/allSteamGamesUpdates.json'), { encoding: 'utf8', flag: 'r' })
    : '{}';    // {[appid]: events[]}
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

const app = express();
app.locals.requestQueue = new PQueue({ interval: WAIT_TIME, intervalCap: NUMBER_OFREQUESTS_PER_WAIT_TIME });
app.locals.gameIDsToCheckPriorityQueue = new PriorityQueue();

function makeRequest(url, method = 'get') {
    return async () => {
        return axios[method](url);
    }
};

// move this to a child process?
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
        // This isn't ideal but it appears to be the most efficient way to do this and is pretty fast...
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
app.locals.allSteamGamesUpdates = JSON.parse(gameUpdatesFromFile);
app.locals.steamGameDetails = JSON.parse(steamGameDetails);
app.locals.allSteamGamesUpdatesPossiblyChanged = JSON.parse(allSteamGamesUpdatesPossiblyChangedFromFile);
app.locals.gameIDsToCheck = app.locals.allSteamGames.map(game => game.appid);
app.locals.gameIDsToCheckIndex = parseInt(gameIDsToCheckIndex, 10);
app.locals.gameIDsWithErrors = new Set(JSON.parse(gameIDsWithErrors));
app.locals.waitBeforeRetrying = false;
const [lastStartTime, lastDailyLimitUsage = 0] = JSON.parse(serverRefreshTimeAndCount);
app.locals.dailyLimit = lastDailyLimitUsage - 200; // Playing it safe and always giving a buffer on startup of 200 less requests so as not to overwhelm the API
app.locals.lastServerRefreshTime = lastStartTime ?? new Date().getTime();
// Since passport isn't properly tracking sessions, we need to track them ourselves.
// We generate our own UUIDs to check against for the mobile app.
app.locals.sessions = new Set();

const ensureAuthenticated = function (req, res, next) {
    if (req.isAuthenticated() || app.locals.sessions.has(req.headers['session-id'])) {
        return next();
    }
    res.redirect('/');
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
                makeRequest(`https://store.steampowered.com/events/ajaxgetadjacentpartnerevents/?appid=${gameID}&count_before=0&count_after=100&event_type_filter=13,12`),
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
const wss = new WebSocketServer({ port: 8081 });

wss.on('connection', function connection(ws) {
    console.log('WebSocket connection established with a client');
    ws.on('error', console.error);
    ws.on('close', () => {
        console.log('Client disconnected');
    });
});
// END Steam Game Updates WebSocket connection

// SteamWebPipes WebSocket connection
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
    app.locals.sessions = new Set();
}, (1000 * 60 * 60 * 24) * 2);    // Set a new interval of 24 hours

// Refresh all games every fifteen minutes
// At this point it's not cleared/guaranteed that the games will always come back in the
// same order, but it appears to be the case, at least for now.
setInterval(async () => {
    console.log('Refreshing all games');
    if (app.locals.dailyLimit > 0 && app.locals.waitBeforeRetrying === false) {
        getAllSteamGameNames().then(allGames => {
            app.locals.dailyLimit--;
            app.locals.allSteamGames = allGames;
            app.locals.gameIDsToCheck = app.locals.allSteamGames.map(game => game.appid);
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
                if (externalGameID == null && priorityGameID == null) {
                    app.locals.gameIDsToCheckIndex++;
                }

                // For now, just keep track of the most recent 10 updates
                const mostRecentEvents = result.events.slice(0, 10).map(event => event.announcement_body);
                const mostRecentKnownEvent = app.locals.allSteamGamesUpdates[gameID]?.[0]?.posttime ?? 0;
                if (mostRecentEvents.length > 0 && mostRecentKnownEvent < mostRecentEvents[0]?.posttime) {
                    app.locals.allSteamGamesUpdates[gameID] = mostRecentEvents

                    // Only increment the index if this was not a manual request.
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
// We go with 1.6 seconds to be on the safe side and build in a little wiggle room for other requests.
setInterval(getGameUpdates, 1000 * 1.6);

// Save the results every 5 minutes so we don't lose them if the server restarts/crashes.
// Write to file for now, but future optimization could be to use something like mongo db.
setInterval(() => {
    // We may as well stop saving the files if the daily limit is 0 so we don't keep writing
    // the same data over and over again.
    if (app.locals.dailyLimit > -2) {
        // Save once after the daily limit is reached, then stop.
        if (app.locals.dailyLimit === -1) {
            app.locals.dailyLimit = -2;
        }
        fs.writeFile(path.join(__dirname, './storage/allSteamGamesUpdates.json'),
            JSON.stringify(app.locals.allSteamGamesUpdates), (err) => {
                if (err) {
                    console.error('Error writing to file allSteamGamesUpdates.json', err);
                } else {
                    console.log('File `allSteamGamesUpdates.json` written successfully');
                }
            });
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
    }
}, 1 * 60 * 1000);

app.use(session({
    secret: config.STEAM_GAME_UPDATES_SECRET,
    name: 'steam-game-updates',
    resave: true,
    saveUninitialized: true
}));

// Initialize Passport and use passport.session() middleware to support
// persistent login sessions.
app.use(passport.initialize());
app.use(passport.session());
app.use(cors());
app.use(useragent.express());

app.set('views', path.join(__dirname, './views'));
app.set('view engine', 'ejs');

// This code makes sure that any request that does not matches a static file
// in the build folder, will just serve index.html. Client side routing is
// going to make sure that the correct content will be loaded.
// app.use((req, res, next) => {
//     if (/(.ico|.js|.css|.jpg|.png|.map|.svg)$/i.test(req.path)) {
//         next();
//     } else {
//         res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
//         res.header('Expires', '-1');
//         res.header('Pragma', 'no-cache');
//         res.sendFile(path.join(__dirname, '../../build', 'index.html'));
//     }
// });

app.use(express.static(path.join(__dirname, '../../build')));

app.get('/close', function (req, res) {
    res.render('close', { user: req.user });
});

app.get('/error', function (req, res) {
    res.render('error', { user: req.user });
});

app.get('/account', ensureAuthenticated, function (req, res) {
    res.send({ user: req.user });
});

app.get('/api/user', (req, res) => {
    if (req.isAuthenticated()) {
        res.json(req.user);
    } else {
        res.status(401).json({ message: 'Not authenticated' });
    }
});

app.get('/api/owned-games', ensureAuthenticated, async (req, res) => {
    if (req.app.locals.waitBeforeRetrying === false && req.app.locals.dailyLimit > 0) {
        let result = '';
        //  If a user has requested their games we need to process it asap.
        await app.locals.requestQueue.add(
            makeRequest(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${config.STEAM_API_KEY}&steamid=${req.query.id}&include_appinfo=true`),
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
        console.log(`Getting the user ${req.query.id}'s owned games completed with ${result.data?.response?.game_count} games`);
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
    res.send(200);
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
            app.locals.allSteamGamesUpdatesPossiblyChanged[gameID] = 0; // Reset the update time for this gameID
            app.locals.gameIDsToCheckPriorityQueue.enqueue(gameID);
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

app.get('/logout', function (req, res) {
    req.logout({}, () => { });
    res.redirect('/close');
});

app.get('/login/ios', function (req, res) {
    res.redirect('/auth/steam');
});

// GET /auth/steam
//   Use passport.authenticate() as route middleware to authenticate the
//   request.  The first step in Steam authentication will involve redirecting
//   the user to steamcommunity.com.  After authenticating, Steam will redirect the
//   user back to this application at /auth/steam/return
app.get('/auth/steam',
    passport.authenticate('steam', { failWithError: true, failureRedirect: '/error', }),
    function (req, res) {
        console.log('Steam auth?');
        res.redirect('/error');
    });

// app.get('/auth/steam', function (req, next) {
//     console.log('worked?', req.query, req.params)
//     return passport.authenticate('steam', { failureRedirect: '/error', })(req, next);
// });

// GET /auth/steam/return
//   Use passport.authenticate() as route middleware to authenticate the
//   request.  If authentication fails, the user will be redirected back to the
//   login page.  Otherwise, the primary route function function will be called,
//   which, in this example, will redirect the user to the home page.
app.get('/auth/steam/return',
    passport.authenticate('steam', { failWithError: true, failureRedirect: '/error' }),
    function (req, res) {
        console.log('Steam returned.');
        const isMobile = req.useragent?.isMobile;
        const user = isMobile && encodeURIComponent(JSON.stringify(req.user));
        const sessionID = isMobile && uuidv4().toString();
        if (sessionID) {
            app.locals.sessions.add(sessionID);
        }
        res.redirect(isMobile ? `steamgameupdatesapp://?user=${user}&sessionID=${sessionID}` : '/close');
    });

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`server listening on port ${PORT}`);
});
