import axios from 'axios';
import { createContext, useCallback, useContext, useEffect, useReducer } from 'react';
import removeAccents from 'remove-accents';
import { notifyUser, webSocketConnectWithRetry } from '../utilities/utils.js';
import backupLogo from './body/steam-logo.svg';

const WEB_SOCKET_PATH = true || window.location.host.includes('steamgameupdates.info') ?
    'wss://steam-game-updates.info/ws' : 'ws://' + (process.env.REACT_APP_WEBSOCKET || 'localhost:8081');

export const AuthContext = createContext();
export const useAuth = () => useContext(AuthContext);

const FILTER_MAPPING = {
    major: [13, 14],
    minor: 12,
    gameEvents: 2,
    newsEvents: 28,
    crossPosts: 34
}

const defaultState = {
    displayName: '',
    id: '',
    identifier: '',
    provider: '',
    photos: [],
    ownedGames: {},     // { [appid]: {name, events} }
    gameUpdates: [],     // [ [updateTime, appid], ... ]
    filteredList: null,
    loadingProgress: null,
    filters: [],
};

const reducer = (state, { type, value }) => {
    switch (type) {
        case 'login': return { ...state, ...value };
        case 'logout':
            localStorage.removeItem('steam-game-updates-user');
            localStorage.removeItem('steam-game-updates-filters');
            return defaultState;
        case 'refreshGames':
            return { ...state, ownedGames: {}, gameUpdates: [], loadingProgress: null };
        case 'addOwnedGamesEvents':
            const newOwnedGames = { ...state.ownedGames, ...value };
            // localStorage.setItem('steam-game-updates-ownedGames', JSON.stringify(newOwnedGames));
            return { ...state, ownedGames: newOwnedGames };
        case 'updateOwnedGames':
            // localStorage.setItem('steam-game-updates-ownedGames', JSON.stringify(value));
            return { ...state, ownedGames: { ...value } };
        case 'updateGameUpdates':
            return { ...state, gameUpdates: value };
        case 'updateSearch':
            const searchTerm = value.toLowerCase().trim();
            const matchedGames = searchTerm === '' ? null :
                Object.entries(state.ownedGames).reduce((acc, [key, value]) => {
                    const { name, events } = value
                    if (removeAccents(name).toLowerCase().includes(searchTerm) && events?.length > 0) {
                        const orderedEvents = events.map(({ posttime }) => [posttime, key]);
                        acc = acc.concat(orderedEvents);
                    }
                    return acc;
                }, []);
            const filteredList = matchedGames?.sort((a, b) => b[0] - a[0]);
            return { ...state, filteredList }
        case 'updateLoadingProgress':
            return { ...state, loadingProgress: value };
        case 'updateFilters':
            // filter out all of these event types
            if (value === 'none') {
                return { ...state, filters: Object.values(FILTER_MAPPING).flat() }
            } else if (value !== 'all') {
                const incomingFilters = [].concat(FILTER_MAPPING[value]);
                const currentFilters = state.filters.reduce((acc, filter) => {
                    return { ...acc, [filter]: true }
                }, {});
                incomingFilters.forEach(filter => {
                    if (currentFilters[filter]) {
                        delete currentFilters[filter];
                    } else {
                        currentFilters[filter] = true;
                    }
                });
                const filters = Object.keys(currentFilters).map(key => parseInt(key));
                localStorage.setItem('steam-game-updates-filters', JSON.stringify(filters))
                return { ...state, filters };
            } else {
                return { ...state, filters: [] }
            }
        default: return state;
    };
};

let gameDetailsWorker = null;
let steamGameUpdatesSocket = null;

export const AuthProvider = function ({ children }) {
    const [state, dispatch] = useReducer(reducer, defaultState);

    useEffect(() => {
        // Populate the context with what's already been stored in local storage.
        let filters = localStorage.getItem('steam-game-updates-filters');
        dispatch({ type: 'updateFilters', value: JSON.parse(filters) })

        function checkLocalStorageIfLoggedIn() {
            let user = localStorage.getItem('steam-game-updates-user');
            if (user != null) {
                user = JSON.parse(user);
                dispatch({ type: 'login', value: user });
            } else {
                dispatch({ type: 'logout' })
            }
            return user;
        };
        (async () => {
            try {
                const isLoggedInLocally = checkLocalStorageIfLoggedIn();
                if (isLoggedInLocally) {
                    // checking if user has a valid session on the server
                    const result = await axios.get('/api/user');
                    if (result?.data) {
                        localStorage.setItem('steam-game-updates-user', JSON.stringify(result.data));
                        dispatch({ type: 'login', value: result.data });
                    }
                }
            } catch (e) {
                (async () => {
                    await localStorage.removeItem('steam-game-updates-user');
                    await localStorage.removeItem('steam-game-updates-filters');
                })();
                console.log('User session has expired - need to log in.');
            }
        })();
    }, []);

    // Web worker setup
    useEffect(() => {
        if (window.Worker) {
            gameDetailsWorker = new Worker(new URL("./workers/gameDetailsWorker.js", import.meta.url));

            // Set up event listeners for messages from the worker
            gameDetailsWorker.onmessage = function (event) {
                const { loadingProgress, ownedGamesWithUpdates, gameUpdatesIDs } = event.data;
                if (loadingProgress != null) {
                    dispatch({ type: 'updateLoadingProgress', value: loadingProgress });
                } else {
                    dispatch({ type: 'updateOwnedGames', value: ownedGamesWithUpdates });
                    dispatch({ type: 'updateGameUpdates', value: gameUpdatesIDs });
                }
            };
            // Clean up the worker when the component unmounts
            return () => {
                gameDetailsWorker.terminate();
            };
        } else {
            console.log("This browser doesn't support web workers.");
        }
    }, []);

    function queueMostRecentUpdatesForGame({ appid, name }) {
        if (appid == null) {
            return null;
        }
        try {
            axios.post('/api/game-updates', { params: { appid } });
        } catch (err) {
            console.error(`Requesting info about ${appid} (${name}) updates failed.`, err);
            return err;
        }
    }

    // Web socket setup
    useEffect(() => {
        if (state.id !== '') {
            if (steamGameUpdatesSocket == null) {
                // UPDATE THIS FROM DEVVVV
                steamGameUpdatesSocket = new webSocketConnectWithRetry({ url: WEB_SOCKET_PATH, isDev: process.env.NODE_ENV === 'development' });
            }
            steamGameUpdatesSocket.onmessage = (event) => {
                // One of two types of messages is being received here:
                // 1. A map of apps that updated which was retrieved from Valve's PICS service
                // 2. An app that updated. e.g. { appid: <appid>, events: [ <event>, ... ] }
                const { appid, eventsLength, apps } = JSON.parse(event.data);
                if (apps != null) {
                    const appids = Object.keys(apps);
                    for (const appid of appids) {
                        if (state.ownedGames[appid] != null) {
                            queueMostRecentUpdatesForGame({ appid, name: state.ownedGames[appid].name });
                        }
                    }
                } else if (appid != null && state.ownedGames[appid] != null && eventsLength > 0) {
                    // If the appid is present, it means a specific game has updated.
                    // console.log(`Notified of ${eventsLength} update(s) for game ${appid} (${state.ownedGames[appid].name})`);
                    const name = state.ownedGames[appid].name;
                    const icon = `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${appid}/${state.ownedGames[appid].img_icon_url}.jpg`
                    notifyUser(name, icon, backupLogo);
                }
                // If this is enabled, the list updates in real time.
                // The issue is that the list shifts around when a new game is added, which isn't ideal.
                // For now utilizing browser notifications to alert the user of updates instead.
                /*  else if (state.ownedGames[appid] != null && events?.length > 0) {
                    dispatch({ type: 'addOwnedGamesEvents', value: { [appid]: { name: state.ownedGames[appid].name, events } } });
                    dispatch({ type: 'updateGameUpdates', value: [[mostRecentUpdateTime, appid]] });
                } */
            }
        }

    }, [state.id, state.ownedGames]);

    const getAllUserOwnedGames = useCallback(async (userID = state.id) => {
        const result = await axios.get('api/owned-games', { params: { id: userID, /* use_local: true  */ } });
        if (result != null) {
            const ownedGames = result?.data?.games?.reduce((acc, game) => {
                return {
                    ...acc, [game.appid]: {
                        name: game.name,
                        img_icon_url: game.img_icon_url,
                        img_logo_url: game.img_logo_url,    // this appears to be missing as of a year ago... https://bit.ly/3SYvabT
                    }
                }
            }, {});
            return ownedGames;
        } else {
            const ownedGames = localStorage.getItem('steam-game-updates-ownedGames');
            return ownedGames && JSON.parse(ownedGames);
        };
    }, [state.id])

    const fetchMoreUpdates = useCallback(() => {
        gameDetailsWorker.postMessage(state.ownedGames);
    }, [state.ownedGames]);

    useEffect(() => {
        if (state.id && Object.keys(state.ownedGames).length === 0) {
            (async () => {
                // First grab all of a user's owned games
                try {
                    const ownedGames = await getAllUserOwnedGames();

                    // Then send the owned games to the worker to get their names
                    if (ownedGames) {
                        gameDetailsWorker.postMessage(ownedGames);
                    }
                } catch (err) {
                    console.error('Getting owned games failed.', err);
                }
            })();
        }
    }, [getAllUserOwnedGames, state.id, state.ownedGames]);

    if (process.env.NODE_ENV === 'development') {
        window.state = state;
    }

    return (
        <AuthContext.Provider
            value={{ ...state, fetchMoreUpdates, dispatch }}
        >
            {children}
        </AuthContext.Provider>
    );
}
