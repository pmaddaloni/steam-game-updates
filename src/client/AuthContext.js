import axios from 'axios';
import { createContext, useCallback, useContext, useEffect, useReducer } from 'react';
import { notifyUser, webSocketConnectWithRetry } from '../utilities/utils.js';
import backupLogo from './body/steam-logo.svg';

const WEB_SOCKET_PATH = window.location.host.includes('steamgameupdates.info') ?
    'wss://https://steamgameupdates.info/websocket' : 'ws://' + (process.env.REACT_APP_WEBSOCKET || 'localhost:8081');

export const AuthContext = createContext();
export const useAuth = () => useContext(AuthContext);

const defaultState = {
    displayName: '',
    id: '',
    identifier: '',
    provider: '',
    photos: [],
    ownedGames: {},     // { [appid]: {name, events} }
    gameUpdates: [],     // [ [updateTime, appid], ... ]
    filteredList: null,
};

const reducer = (state, { type, value }) => {
    switch (type) {
        case 'login': return { ...state, ...value };
        case 'logout': return defaultState;
        case 'refreshGames':
            return { ...state, ownedGames: {}, gameUpdates: [] };
        case 'addOwnedGamesEvents':
            const newOwnedGames = { ...state.ownedGames, ...value };
            // localStorage.setItem('steam-game-updates-ownedGames', JSON.stringify(newOwnedGames));
            return { ...state, ownedGames: newOwnedGames };
        case 'updateOwnedGames':
            // localStorage.setItem('steam-game-updates-ownedGames', JSON.stringify(value));
            return { ...state, ownedGames: { ...value } };
        case 'updateGameUpdates':
            let newGameUpdates = state.gameUpdates.concat(value);
            newGameUpdates = newGameUpdates.sort((a, b) => b[0] - a[0]);
            return { ...state, gameUpdates: newGameUpdates };
        case 'updateSearch':
            const searchTerm = value.toLowerCase().trim();
            const filteredList = searchTerm === '' ? null :
                Object.entries(state.ownedGames).reduce((acc, [key, value]) => {
                    const result = { ...acc };
                    const { name } = value
                    if (name.toLowerCase().includes(searchTerm)) {
                        result[key] = value
                    }
                    return result;
                }, {});
            return { ...state, filteredList }
        default: return state;
    };
};

let gameDetailsWorker = null;
let steamGameUpdatesSocket = null;

export const AuthProvider = function ({ children }) {
    const [state, dispatch] = useReducer(reducer, defaultState);

    // Web worker setup
    useEffect(() => {
        if (window.Worker) {
            gameDetailsWorker = new Worker(new URL("./workers/gameDetailsWorker.js", import.meta.url));

            // Set up event listeners for messages from the worker
            gameDetailsWorker.onmessage = function (event) {
                const { ownedGamesWithUpdates, gameUpdatesIDs } = event.data;
                dispatch({ type: 'updateOwnedGames', value: ownedGamesWithUpdates });
                dispatch({ type: 'updateGameUpdates', value: gameUpdatesIDs });
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
                steamGameUpdatesSocket = new webSocketConnectWithRetry(WEB_SOCKET_PATH);
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
                    console.log(`Notified of ${eventsLength} update(s) for game ${appid} (${state.ownedGames[appid].name})`);
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

    }, [state.id, state.ownedGames])

    // Populate the context with what's already been stored in local storage.
    const checkLocalStorage = useCallback(() => {
        let user = localStorage.getItem('steam-game-updates-user');
        if (user != null) {
            user = JSON.parse(user);
            dispatch({ type: 'login', value: user });
        } else {
            dispatch({ type: 'logout' })
        }
    }, [dispatch]);

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
        (async () => {
            try {
                // checking if user has a valid session on the server first
                await axios.get('/api/user');
                checkLocalStorage();
            } catch (e) {
                console.log('User session has expired - need to log in.');
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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

    // REMOVE THIS WHEN DEPLOYING
    window.state = state;

    return <AuthContext.Provider
        value={{ ...state, fetchMoreUpdates, getAllUserOwnedGames, dispatch }}
    >
        {children}
    </AuthContext.Provider>
}
