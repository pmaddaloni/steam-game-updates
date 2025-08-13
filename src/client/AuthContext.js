import axios from 'axios';
import { createContext, useCallback, useContext, useEffect, useReducer } from 'react';
import removeAccents from 'remove-accents';

import { createWebSocketConnector, notifyUser } from '../utilities/utils.js';
import backupLogo from './body/steam-logo.svg';

const WEB_SOCKET_PATH = window.location.host.includes('steamgameupdates.info') ?
    'wss://api.steamgameupdates.info' : 'ws://' + (process.env.REACT_APP_WEBSOCKET || 'localhost');

export const AuthContext = createContext();
export const useAuth = () => useContext(AuthContext);

// Break up a person's library request into chunks so as not to overwhelm the API.
const REQUEST_SIZE = 250;

const FILTER_MAPPING = {
    major: [13, 14],
    minor: 12,
    gameEvents: 2,
    newsEvents: 28,
    crossPosts: 34
}

export const FILTER_REVERSE_MAPPING = {
    14: 'major',
    13: 'major',
    12: 'minor',
    2: 'gameEvents',
    28: 'newsEvents',
    34: 'crossPosts'
}

const defaultState = {
    displayName: '',
    id: '',
    identifier: '',
    provider: '',
    photos: [],
    ownedGames: null,     // { [appid]: {name, events} }
    gameUpdates: [],     // [ [updateTime, appid], ... ]
    filteredList: null,
    loadingProgress: null,
    filters: [],
    menuFilters: [],
    notificationsAllowed: false,
};

const reducer = (state, { type, value }) => {
    switch (type) {
        case 'login':
            return { ...state, ...value };
        case 'logout':
            localStorage.removeItem('steam-game-updates-user');
            localStorage.removeItem('steam-game-updates-filters');
            localStorage.removeItem('steam-game-updates-notifications-allowed')
            axios.post('/api/logout', { id: state.id, appids: Object.keys(state.ownedGames ?? []) }, { withCredentials: true })
            return defaultState;
        case 'refreshGames':
            return { ...state, ownedGames: null, gameUpdates: [], loadingProgress: null };
        case 'addOwnedGamesEvents':
            const newOwnedGames = { ...state.ownedGames, ...value };
            // localStorage.setItem('steam-game-updates-ownedGames', JSON.stringify(newOwnedGames));
            return { ...state, ownedGames: newOwnedGames };
        case 'updateOwnedGames':
            // localStorage.setItem('steam-game-updates-ownedGames', JSON.stringify(value));
            return { ...state, ownedGames: { ...state.ownedGames, ...value } };
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
            const filteredList = matchedGames && matchedGames.sort((a, b) => b[0] - a[0]);
            return { ...state, filteredList }
        case 'updateLoadingProgress':
            return { ...state, loadingProgress: value };
        case 'updateFilters':
            // filter out all of these event types
            let filters;
            if (value === 'none') {
                filters = Object.values(FILTER_MAPPING).flat()
            } else if (value !== 'all') {
                const incomingFilters = [].concat(FILTER_MAPPING[value]);
                filters = [...state.filters];
                for (const filter of incomingFilters) {
                    if (state.filters.includes(filter)) {
                        filters = filters.filter(f => f !== filter);
                    } else {
                        filters.push(filter)
                    }
                }
            } else {
                filters = [];
            }
            localStorage.setItem('steam-game-updates-filters', JSON.stringify(filters));
            return { ...state, filters }
        case 'setFilters':
            const filterSet = new Set();
            value.forEach(f => {
                filterSet.add(FILTER_REVERSE_MAPPING[f]);
            })
            return { ...state, filters: value, menuFilters: [...filterSet] }
        case 'setNotificationsAllowed':
            localStorage.setItem('steam-game-updates-notifications-allowed', JSON.stringify(value));
            return { ...state, notificationsAllowed: value }
        default: return state;
    };
};

let gameDetailsWorker = null;
let gameUpdatesWorker = null;
let steamGameUpdatesSocket = null;

export const AuthProvider = function ({ children }) {
    const [state, dispatch] = useReducer(reducer, defaultState);

    useEffect(() => {
        // Populate the context with what's already been stored in local storage.
        async function checkLocalStorageIfLoggedIn() {
            let user = await localStorage.getItem('steam-game-updates-user');
            if (user != null) {
                user = JSON.parse(user);
                dispatch({ type: 'login', value: user });
                let storedGameUpdatesFilters = await localStorage.getItem('steam-game-updates-filters');
                if (storedGameUpdatesFilters != null) {
                    const parsedGameUpdatesFilters = JSON.parse(storedGameUpdatesFilters);
                    dispatch({ type: 'setFilters', value: parsedGameUpdatesFilters });
                }
                let storedNotificationsAllowed = await localStorage.getItem('steam-game-updates-notifications-allowed');
                if (storedNotificationsAllowed != null) {
                    const parsedNotificationsAllowed = JSON.parse(storedNotificationsAllowed);
                    dispatch({ type: 'setNotificationsAllowed', value: parsedNotificationsAllowed });
                }
            } else {
                dispatch({ type: 'logout' })
            }
            return user;
        };
        (async () => {
            try {
                const isLoggedInLocally = await checkLocalStorageIfLoggedIn();
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
                    await localStorage.removeItem('steam-game-updates-notifications-allowed');
                })();
                console.log('User session has expired - need to log in.');
            }
        })();
    }, []);

    // Web worker setup
    useEffect(() => {
        if (window.Worker) {
            gameUpdatesWorker = new Worker(new URL("./workers/gameUpdatesWorker.js", import.meta.url));

            gameDetailsWorker = new Worker(new URL("./workers/gameDetailsWorker.js", import.meta.url));
            // Set up event listeners for messages from the worker
            gameDetailsWorker.onmessage = function (event) {
                const { loadingProgress, ownedGamesWithUpdates, gameUpdatesIDs } = event.data;
                if (loadingProgress != null) {
                    dispatch({ type: 'updateLoadingProgress', value: loadingProgress });
                } else if (gameUpdatesIDs != null) {
                    dispatch({ type: 'updateGameUpdates', value: gameUpdatesIDs });
                } else {
                    dispatch({ type: 'updateOwnedGames', value: ownedGamesWithUpdates });
                }
            };
            // Clean up the worker when the component unmounts
            return () => {
                gameUpdatesWorker.terminate();
                gameDetailsWorker.terminate();
            };
        } else {
            console.log("This browser doesn't support web workers.");
        }
    }, []);

    // Web socket setup
    useEffect(() => {
        if (state.id !== '') {
            const onMessage = async (event) => {
                // An app that updated. e.g. { appid: <appid>, events: [ <event>, ... ] }
                if (state.notificationsAllowed) {
                    const { appid, name, usersToNotify } = JSON.parse(event.data);
                    if (appid != null && state.ownedGames != null) {
                        if (usersToNotify.includes(state.id)) {
                            const icon = state.ownedGames[appid] && `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${appid}/${state.ownedGames[appid].img_icon_url}.jpg`
                            notifyUser(name, icon, backupLogo);
                        }
                    }
                }
            }
            if (steamGameUpdatesSocket == null) {
                steamGameUpdatesSocket = createWebSocketConnector(WEB_SOCKET_PATH, { onMessage });
                steamGameUpdatesSocket.start();
            } else {
                steamGameUpdatesSocket.updateOnMessage(onMessage);
            }
        }
    }, [state.id, state.notificationsAllowed, state.ownedGames]);

    const getAllUserOwnedGames = useCallback(async (userID = state.id) => {
        const result = await axios.get('api/owned-games', { params: { id: userID } });
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
        } /* else {
            const ownedGames = localStorage.getItem('steam-game-updates-ownedGames');
            return ownedGames && JSON.parse(ownedGames);
        }; */
    }, [state.id])

    useEffect(() => {
        if (state.id && state.ownedGames == null) {
            (async () => {
                dispatch({ type: 'updateLoadingProgress', value: 0 });
                // First grab all of a user's owned games
                try {
                    const ownedGames = await getAllUserOwnedGames();
                    // total is one request for getting owned games, one for posting their keys to server
                    // and # of ownedGames divided by chunk size
                    // Then send the owned games to the worker to get their events
                    if (ownedGames) {
                        const totalNumberOfRequests = Math.ceil(Object.keys(ownedGames).length / REQUEST_SIZE) + 2;
                        dispatch({ type: 'updateLoadingProgress', value: (1 / totalNumberOfRequests) * 100 });
                        gameDetailsWorker.postMessage({ ownedGames, totalNumberOfRequests, requestSize: REQUEST_SIZE, id: `web-client-${state.id}` });
                    } else {
                        dispatch({ type: 'updateLoadingProgress', value: 100 });
                        dispatch({ type: 'updateOwnedGames', value: {} });
                        dispatch({ type: 'updateGameUpdates', value: [] });
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
            value={{ ...state, dispatch }}
        >
            {children}
        </AuthContext.Provider>
    );
}
