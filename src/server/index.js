import axios from 'axios';
import cors from 'cors';
import express from 'express';
import session from 'express-session';
import fs from 'fs';
import passport from 'passport';
import { Strategy as SteamStrategy } from 'passport-steam';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket, { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);  // get the resolved path to the file
const __dirname = path.dirname(__filename);         // get the name of the directory

// move this to a child process
// https://stackoverflow.com/questions/33030092/webworkers-with-a-node-js-express-application
async function getAllSteamGameNames() {
    return axios.get('https://api.steampowered.com/ISteamApps/GetAppList/v0002/').then((result) => {
        // disregard apps without a name
        let games = result.data.applist.apps.filter(app => app.name !== '').sort((a, b) => a.appid - b.appid);
        // Remove duplicates by appid
        // This operation is slow, but having duplicate entries for a game could be worth it?
        // games = Array.from(new Set(games.map(a => a.appid))).map(appid => {
        //     return games.find(a => a.appid === appid)
        // })
        console.log(`Server has retrieved all ${games.length} games`, games.slice(0, 30));
        return games;
    }).catch(err => {
        console.error('Retrieving all games from Steam API failed.', err);
    })
}

async function getGameIDUpdates(gameID) {
    let result = null;
    if (gameID == null) {
        return {
            success: 500,
            retryAfter: -1,
        };
    }
    try {
        const response =
            await axios.get(`https://store.steampowered.com/events/ajaxgetadjacentpartnerevents/?appid=${gameID}&count_before=0&count_after=100&event_type_filter=13,12`)
        result = response.data;
    } catch (err) {
        if (err.response?.status === 429) {
            const resultRetryAfter = err.response.headers['retry-after'];
            if (resultRetryAfter) {
                console.log(`Rate limited. Retry after: ${resultRetryAfter} seconds.`);
                const retryAfterSeconds = parseInt(resultRetryAfter, 10);
                result = {
                    success: 429,
                    retryAfter: retryAfterSeconds
                }
            } else {
                console.log('Rate limited, but no Retry-After header found.');
                result = {
                    success: 403,
                    retryAfter: 300
                }
            }
        } else {
            // Something went wrong other than rate limiting
            console.error(`Getting the game ${gameID}'s updates failed.`, err.message, err.response?.data);
            result = {
                success: 500,
                retryAfter: -1,
            }
        }
    }
    return result;
}

// Simple route middleware to ensure user is authenticated.
//   Use this route middleware on any resource that needs to be protected.  If
//   the request is authenticated (typically via a persistent login session),
//   the request will proceed.  Otherwise, the user will be redirected to the
//   login page.
const ensureAuthenticated = function (req, res, next) {
    if (req.isAuthenticated()) { return next(); }
    res.redirect('/');
}

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
    apiKey: '***REMOVED_API_KEY***'
},
    function (identifier, profile, done) {
        // asynchronous verification, for effect...
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

// TODO: This can reach 1.7GB in size, so need to examine storing it in multuple files...
const gameUpdatesFromFile =
    fs.readFileSync(path.join(__dirname, './allSteamGamesUpdates.txt'), { encoding: 'utf8', flag: 'r' })
    || '{}';    // {[appid]: events[]}
const allSteamGamesUpdatesPossiblyChangedFromFile =
    fs.readFileSync(path.join(__dirname, './allSteamGamesUpdatesPossiblyChanged.txt'), { encoding: 'utf8', flag: 'r' })
    || '{}';    // {[appid]: POSSIBLE most recent update time}
const gameIDsWithErrors =
    fs.readFileSync(path.join(__dirname, './gameIDsWithErrors.txt'), { encoding: 'utf8', flag: 'r' })
    || '[]';    // [appid]
const gameIDsToCheckIndex =
    fs.readFileSync(path.join(__dirname, './gameIDsToCheckIndex.txt'), { encoding: 'utf8', flag: 'r' })
    || '0';     // For incrementing through ALL steam games - takes about 2.5 days at 100k requests/day
const allSteamGameIDsOrderedByUpdateTime =
    fs.readFileSync(path.join(__dirname, './allSteamGameIDsOrderedByUpdateTime.txt'), { encoding: 'utf8', flag: 'r' })
    || '[]';    // [appid]

const app = express();
app.locals.allSteamGames = await getAllSteamGameNames();
app.locals.allSteamGamesUpdates = JSON.parse(gameUpdatesFromFile);
app.locals.allSteamGameIDsOrderedByUpdateTime = JSON.parse(allSteamGameIDsOrderedByUpdateTime);
app.locals.allSteamGamesUpdatesPossiblyChanged = JSON.parse(allSteamGamesUpdatesPossiblyChangedFromFile);
app.locals.gameIDsToCheck = app.locals.allSteamGames.map(game => game.appid);
app.locals.gameIDsToCheckPriorityQueue = [];
app.locals.gameIDsToCheckIndex = parseInt(gameIDsToCheckIndex, 10);
app.locals.gameIDsWithErrors = new Set(JSON.parse(gameIDsWithErrors));
app.locals.waitBeforeRetrying = false;
app.locals.dailyLimit = 1000;  // should be 100k, but for testing purposes it's lower for now

console.log(`Server has loaded up ${Object.keys(app.locals.allSteamGamesUpdates).length} games with their updates.`);

// SteamWebPipes WebSocket connection
const targetWsUrl = 'ws://localhost:8181';
const ws = new WebSocket(targetWsUrl);

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


// https://steamcommunity.com/dev/apiterms#:~:text=any%20Steam%20game.-,You%20may%20not%20use%20the%20Steam%20Web%20API%20or%20Steam,Steam%20Web%20API%20per%20day.
// Reset the daily limit every 24 hours
setInterval(() => app.locals.dailyLimit = 100000, 1000 * 60 * 60 * 24);

// Refresh all games every fifteen minutes
// At this point it's not cleared/guaranteed that the games will always come back in the
// same order, but it appears to be the case, at least for now.
setInterval(async () => {
    if (app.locals.dailyLimit > 0 && app.locals.waitBeforeRetrying === false) {
        const allGames = await getAllSteamGameNames();
        app.locals.dailyLimit--;
        app.locals.allSteamGames = allGames;
        app.locals.gameIDsToCheck = app.locals.allSteamGames.map(game => game.appid);
    }
}, 15 * 60 * 1000)

const getGameUpdates = async (externalGameID) => {
    const priorityGameID = app.locals.gameIDsToCheckPriorityQueue.shift();
    const gameID = externalGameID || priorityGameID
        || app.locals.gameIDsToCheck[app.locals.gameIDsToCheckIndex];
    if (app.locals.dailyLimit > 0
        && app.locals.waitBeforeRetrying === false) {

        // Skip the gameID if it has already been checked and failed, and this wasn't a manual request.
        if (app.locals.gameIDsWithErrors.has(gameID) && !externalGameID && !priorityGameID) {
            app.locals.gameIDsToCheckIndex++;
        } else {
            const result = await getGameIDUpdates(gameID);
            app.locals.dailyLimit--;

            if (result.success === 1) {
                // For now, just keep track of the most recent 10 updates
                app.locals.allSteamGamesUpdates[gameID] =
                    result.events.slice(0, 10).map(event => event.announcement_body);
                // app.locals.allSteamGameIDsOrderedByUpdateTime
                let mostRecentUpdateTime = app.locals.allSteamGamesUpdates[gameID][0]?.posttime;
                if (mostRecentUpdateTime != null) {
                    if (app.locals.allSteamGameIDsOrderedByUpdateTime[mostRecentUpdateTime] != null) {
                        // Handle the very very rare case where two games have the exact same update time
                        mostRecentUpdateTime++;
                    }

                    const index = app.locals.allSteamGameIDsOrderedByUpdateTime.findIndex(([, appid]) => appid === gameID);
                    if (index !== -1) {
                        const currentTime = app.locals.allSteamGameIDsOrderedByUpdateTime[index][0]
                        app.locals.allSteamGameIDsOrderedByUpdateTime[index][0] = Math.max(mostRecentUpdateTime, currentTime);
                    } else {
                        app.locals.allSteamGameIDsOrderedByUpdateTime.push([mostRecentUpdateTime, gameID]);
                    }
                    app.locals.allSteamGameIDsOrderedByUpdateTime.sort((a, b) => b[0] - a[0]);
                }
                // Only increment the index if this was not a manual request.
                if (externalGameID == null) {
                    app.locals.gameIDsToCheckIndex++;
                }
                // let clients know a new update has been processed
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send({
                            appid: gameID,
                            events: app.locals.allSteamGamesUpdates[gameID],
                        });
                    }
                });
                console.log(`Getting the game ${gameID}'s updates completed with ${result.events?.length} events`);
            } else if (result.status === 429 || result.status === 403) {
                app.locals.waitBeforeRetrying = true;
                setTimeout(() => app.locals.waitBeforeRetrying = false, result.retryAfter * 1000);
                console.log(`${result.status === 403 ?
                    'Steam API is refusing' : 'Steam API rate limit reached'}; retrying after: ${result.retryAfter} seconds.`);
            } else {
                // This gameID has not been found for whatever reason, so don't try it again.
                app.locals.gameIDsWithErrors.add(gameID);
                console.log(`Getting the game ${gameID}'s updates failed with code ${result.success}`);
                // Only increment the index if this was not a manual request.
                if (externalGameID == null) {
                    app.locals.gameIDsToCheckIndex++;
                }
            }
        }
        if (app.locals.gameIDsToCheckIndex >= app.locals.gameIDsToCheck.length) {
            app.locals.gameIDsToCheckIndex = 0; // Loop back to the beginning
        }
    }

    if (app.locals.dailyLimit === 0) {
        console.log('Daily limit reached. Waiting for the next day to continue.');
    }
}

// Continuously fetch game's updates every 1 second iterating over the gameIDsToCheck array.
// Constraint of 100000k allows for an average of one request every 0.86 seconds over 24 hours.
// Constraint of 200 per 5 minutes restricts to no more than one request every 1.5 seconds within any 5 - minute window.
// We go with 1.6 seconds to be on the safe side.
setInterval(getGameUpdates, 1 * 1600);

// Save the results every 5 minutes so we don't lose them if the server restarts/crashes.
// Write to file for now, but future optimization could be to use something like mongo db.
setInterval(() => {
    // We may as well stop saving the files if the daily limit is 0 so we don't keep writing
    // the same data over and over again.
    // TODO: Optimization -> save once after the daily limit is reached, THEN stop.
    if (app.locals.dailyLimit !== 0) {
        fs.writeFile(path.join(__dirname, './allSteamGamesUpdates.txt'), JSON.stringify(app.locals.allSteamGamesUpdates), (err) => {
            if (err) {
                console.error('Error writing to file allSteamGamesUpdates.txt', err);
            } else {
                console.log('File `allSteamGamesUpdates.txt` written successfully');
            }
        });
        fs.writeFile(path.join(__dirname, './gameIDsWithErrors.txt'), JSON.stringify(Array.from(app.locals.gameIDsWithErrors)), (err) => {
            if (err) {
                console.error('Error writing to file gameIDsWithErrors.txt', err);
            } else {
                console.log('File `gameIDsWithErrors.txt` written successfully');
            }
        });
        fs.writeFile(path.join(__dirname, './gameIDsToCheckIndex.txt'), app.locals.gameIDsToCheckIndex.toString(), (err) => {
            if (err) {
                console.error('Error writing to file gameIDsToCheckIndex.txt', err);
            } else {
                console.log('File `gameIDsToCheckIndex.txt` written successfully');
            }
        });
        fs.writeFile(path.join(__dirname, './allSteamGameIDsOrderedByUpdateTime.txt'), JSON.stringify(app.locals.allSteamGameIDsOrderedByUpdateTime), (err) => {
            if (err) {
                console.error('Error writing to file allSteamGameIDsOrderedByUpdateTime.txt', err);
            } else {
                console.log('File `allSteamGameIDsOrderedByUpdateTime.txt` written successfully');
            }
        });
        fs.writeFile(path.join(__dirname, './allSteamGamesUpdatesPossiblyChanged.txt'), JSON.stringify(app.locals.allSteamGamesUpdatesPossiblyChanged), (err) => {
            if (err) {
                console.error('Error writing to file allSteamGamesUpdatesPossiblyChanged.txt', err);
            } else {
                console.log('File `allSteamGamesUpdatesPossiblyChanged.txt` written successfully');
            }
        });
    }
}, 1 * 60 * 1000);

app.use(session({
    secret: 'steam-game-updates-secret',
    name: 'steam-game-updates',
    resave: true,
    saveUninitialized: true
}));

// Initialize Passport and use passport.session() middleware to support
// persistent login sessions.
app.use(passport.initialize());
app.use(passport.session());
app.use(cors());

app.set('views', path.join(__dirname, '..', './views'));
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

app.get('/api/owned-games', async (req, res) => {
    // if (req.app.locals.waitBeforeRetrying === false && req.app.locals.dailyLimit > 0) {
    let result = '';
    await axios.get(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=***REMOVED_API_KEY***&steamid=${req.query.id}`)
        .then(response => result = response)
        .catch(err => console.error(`Getting the user ${req.query.id}'s owned games failed.`, err));
    res.send(result.data?.response);
    // } else {
    //     res.status(400).send(new Error(`The limit for requests has been reached: retry later ${req.app.locals.waitBeforeRetrying}, daily limit ${req.app.locals.dailyLimit}`));
    // }
    app.locals.dailyLimit--;
});

app.get('/api/all-steam-games', async (req, res) => {
    res.send(req.app.locals.allSteamGames);
});

app.get('/api/game-updates', async (req, res) => {
    const gameID = req.query.appid;
    if (!req.app.locals.gameIDsWithErrors.has(gameID)) {
        await getGameUpdates(gameID);
    }
    if (app.locals.gameIDsWithErrors.has(gameID)) {
        res.send([]);   // This game doesn't have updates
    } else {
        res.send(app.locals.allSteamGamesUpdates[gameID]);
    }
});

app.get('/api/game-updates-for-owned-games', async (req, res) => {
    const gameIDs = Object.values(req.query.appids ?? {}).map(gameID => parseInt(gameID, 10));
    const updates = []; // An array of {appid: gameID, events: []} in order of most recently updated

    // iterate through all passed in games and add them if found
    for (const gameID of gameIDs) {
        // The gameID is the second element in the array
        const [updateTime] = app.locals.allSteamGameIDsOrderedByUpdateTime.find(([, appid]) => gameID === appid) ?? [];
        let mostRecentUpdateTime = updateTime;
        if (updateTime == null || app.locals.allSteamGamesUpdatesPossiblyChanged[gameID] > updateTime) {
            app.locals.gameIDsToCheckPriorityQueue.push(gameID);
            console.log(`Game ${gameID} has been added to the priority queue for updates.`);
        } else {
            updates.push(
                {
                    appid: gameID,
                    events: app.locals.allSteamGamesUpdates[gameID],
                    mostRecentUpdateTime
                }
            );
        }
    }
    res.send({ updates });
});

app.get('/api/steam-game-details', async (req, res) => {
    let result = null;
    if (req.app.locals.waitBeforeRetrying === false && req.app.locals.dailyLimit > 0) {
        await axios.get(`https://store.steampowered.com/api/appdetails?appids=${req.query.id}`)
            .then(response => result = response)
            .catch(err => console.error(`Getting the game ${req.query.id}'s details failed.`, err));
        res.send(result.data);
    } else {
        res.status(400).send(new Error(`The limit for requests has been reached: retry later ${req.app.locals.waitBeforeRetrying}, daily limit ${req.app.locals.dailyLimit}`));
    }
    app.locals.dailyLimit--;
});

app.get('/logout', function (req, res) {
    req.logout({}, () => { });
    res.redirect('/close');
});

// GET /auth/steam
//   Use passport.authenticate() as route middleware to authenticate the
//   request.  The first step in Steam authentication will involve redirecting
//   the user to steamcommunity.com.  After authenticating, Steam will redirect the
//   user back to this application at /auth/steam/return
app.get('/auth/steam',
    passport.authenticate('steam', { failureRedirect: '/' }),
    function (req, res) {
        res.redirect('/');
    });

// GET /auth/steam/return
//   Use passport.authenticate() as route middleware to authenticate the
//   request.  If authentication fails, the user will be redirected back to the
//   login page.  Otherwise, the primary route function function will be called,
//   which, in this example, will redirect the user to the home page.
app.get('/auth/steam/return',
    passport.authenticate('steam', { failureRedirect: '/' }),
    function (req, res) {
        res.redirect('/close');
    });

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`server listening on port ${PORT}`);
    console.log('Press Ctrl+C to quit.');
});
