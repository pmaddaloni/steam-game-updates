import axios from 'axios';
import { createContext, useCallback, useContext, useEffect, useReducer } from 'react';
import removeAccents from 'remove-accents';

import { createWebSocketConnector, getClientInfo, notifyUser, SUBSCRIPTION_BROWSER_ID_SUFFIX } from '../utilities/utils.js';
import backupLogo from './body/steam-logo.svg';

const WEB_SOCKET_PATH = window.location.host.includes('steamgameupdates.info') ?
    'wss://api.steamgameupdates.info' : 'ws://' + (process.env.REACT_APP_WEBSOCKET || 'localhost');

export const AuthContext = createContext();
export const useAuth = () => useContext(AuthContext);

// Break up a person's library request into chunks so as not to overwhelm the API.
const REQUEST_SIZE = 250;
const CLIENT_INFO = `${SUBSCRIPTION_BROWSER_ID_SUFFIX}: ${getClientInfo().browser}`;

export const FILTER_MAPPING = (() => {
    const mapping = {
        major: [13, 14],
        minor: 12,
        gameEvents: 2,
        newsEvents: 28,
        crossPosts: 34
    };
    const used = new Set(
        Object.values(mapping).flat()
    );
    mapping.allOtherEvents = Array.from({ length: 35 }, (_, i) => i + 1)
        .filter(v => !used.has(v));

    return mapping;
})();

export const FILTER_REVERSE_MAPPING = ((obj) => {
    const inverted = {};
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            inverted[obj[key]] = key;
        }
    }
    return inverted;
})(FILTER_MAPPING);

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
    totalGameUpdates: null,
    notificationsAllowed: false,
};

const reducer = (state, { type, value }) => {
    switch (type) {
        case 'login':
            return { ...state, ...value };
        case 'logout':
            localStorage.removeItem('steam-game-updates-user');
            localStorage.removeItem('steam-game-updates-filters');
            localStorage.removeItem('steam-game-updates-notifications-allowed');
            localStorage.removeItem('steam-game-updates-retrievalAmount');
            axios.post('/api/logout', { id: state.id + CLIENT_INFO, appids: Object.keys(state.ownedGames ?? []) })
            return defaultState;
        case 'refreshGames':
            return {
                ...state,
                loadingProgress: null,
                filteredList: null,
            };
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
        case 'setTotalGameUpdates':
            return { ...state, totalGameUpdates: value };
        case 'setRetrievalAmount':
            localStorage.setItem('steam-game-updates-retrievalAmount', JSON.stringify(value));
            return { ...state, retrievalAmount: value }
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
            axios.post('/api/notifications/filters', { id: state.id + CLIENT_INFO, filters });
            return { ...state, filters }
        case 'setFilters':
            if (state.id) {
                axios.post('/api/notifications/filters', { id: state.id + CLIENT_INFO, filters: value });
            }
            const filterSet = new Set();
            value.forEach(f => {
                filterSet.add(FILTER_REVERSE_MAPPING[f]);
            })
            return { ...state, filters: value, menuFilters: [...filterSet] }
        case 'setNotificationsAllowed':
            if (Notification.permission === "granted") {
                if (state.id !== '' && state.id != null) {
                    localStorage.setItem('steam-game-updates-notifications-allowed', JSON.stringify(value));
                    if (value) {
                        axios.post('/api/notification/subscribe', {
                            id: state.id + CLIENT_INFO,
                            filters: state.filters,
                            appids: Object.keys(state.ownedGames ?? [])
                        });
                    } else {
                        axios.post('/api/notification/unsubscribe', {
                            id: state.id + CLIENT_INFO,
                            filters: state.filters,
                            appids: Object.keys(state.ownedGames ?? [])
                        });
                    }
                    return { ...state, notificationsAllowed: value }
                }
                return { ...state, notificationsAllowed: value }
            }
            return state;
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
            let parsedGameUpdatesFilters = [];
            if (user != null) {
                user = JSON.parse(user);
                let storedGameUpdatesFilters = await localStorage.getItem('steam-game-updates-filters');
                if (storedGameUpdatesFilters != null) {
                    dispatch({ type: 'setFilters', value: JSON.parse(storedGameUpdatesFilters) });
                }
                let storedNotificationsAllowed = await localStorage.getItem('steam-game-updates-notifications-allowed');
                if (storedNotificationsAllowed != null) {
                    dispatch({ type: 'setNotificationsAllowed', value: JSON.parse(storedNotificationsAllowed) });
                }
                let storedRetrievalAmount = await localStorage.getItem('steam-game-updates-retrievalAmount');
                if (storedRetrievalAmount != null) {
                    dispatch({ type: 'setRetrievalAmount', value: JSON.parse(storedRetrievalAmount) });
                }
            } else {
                dispatch({ type: 'logout' })
            }
            return { user, parsedGameUpdatesFilters };
        };
        (async () => {
            try {
                const { user, parsedGameUpdatesFilters } = await checkLocalStorageIfLoggedIn();
                if (user) {
                    // checking if user has a valid session on the server
                    const result = await axios.get('/api/user');
                    if (result?.data) {
                        localStorage.setItem('steam-game-updates-user', JSON.stringify(result.data));
                        dispatch({ type: 'login', value: result.data });
                        dispatch({ type: 'setFilters', value: parsedGameUpdatesFilters });
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
                const { loadingProgress, ownedGamesWithUpdates, gameUpdatesIDs, totalUpdates } = event.data;
                if (loadingProgress != null) {
                    dispatch({ type: 'updateLoadingProgress', value: loadingProgress });
                } else if (gameUpdatesIDs != null) {
                    dispatch({ type: 'updateGameUpdates', value: gameUpdatesIDs });
                    if (totalUpdates != null) {
                        dispatch({ type: 'setTotalGameUpdates', value: totalUpdates });
                    }
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
                    const { appid, name, eventTitle } = JSON.parse(event.data);
                    if (appid != null && state.ownedGames != null) {
                        const icon = state.ownedGames[appid] && `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${appid}/${state.ownedGames[appid].img_icon_url}.jpg`
                        notifyUser(name, eventTitle, icon, backupLogo);
                    }
                }
            }
            if (steamGameUpdatesSocket == null) {
                steamGameUpdatesSocket = createWebSocketConnector(WEB_SOCKET_PATH + `?id=${state.id}${CLIENT_INFO}`, { onMessage });
                steamGameUpdatesSocket.start();
            } else {
                steamGameUpdatesSocket.updateOnMessage(onMessage);
            }
        }
    }, [state.id, state.notificationsAllowed, state.ownedGames]);

    const getAllUserOwnedGames = useCallback(async (userID = state.id) => {
        const result = await axios.get('api/owned-games', { params: { id: userID } });
        if (result != null) {
            const ownedGames = {};
            for (const game of result?.data?.games ?? []) {
                ownedGames[game.appid] = {
                    name: game.name,
                    img_icon_url: game.img_icon_url,
                    img_logo_url: game.img_logo_url, // note: may be missing
                };
            }
            return ownedGames;
        } /* else {
            const ownedGames = localStorage.getItem('steam-game-updates-ownedGames');
            return ownedGames && JSON.parse(ownedGames);
        }; */
    }, [state.id])

    useEffect(() => {
        if (state.id && state.loadingProgress === null) {
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
                        gameDetailsWorker.postMessage({
                            ownedGames,
                            totalNumberOfRequests,
                            requestSize: REQUEST_SIZE,
                            id: state.id,
                            filters: state.filters,
                            retrievalAmount: state.retrievalAmount
                        });
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getAllUserOwnedGames, state.id, state.loadingProgress]);

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
