import axios from 'axios';
import React, { createContext, useCallback, useContext, useEffect, useReducer } from 'react';
export const AuthContext = createContext();
export const useAuth = () => useContext(AuthContext);

const defaultState = {
    displayName: '',
    id: '',
    identifier: '',
    provider: '',
    photos: [],
    ownedGames: {},     // { [appid]: {name, events} }
    gameUpdates: []     // [ appid, ... ]
};

const reducer = (state, { type, value }) => {
    switch (type) {
        case 'login': return { ...state, ...value };
        case 'logout': return defaultState;
        case 'updateOwnedGames': return { ...state, ownedGames: { ...value } };
        case 'updateGameUpdates': return { ...state, gameUpdates: [].concat(value).concat(state.gameUpdates) };
        default: return state;
    };
};

let gameDetailsWorker = null;
let gameUpdatesWorker = null;
let steamGameUpdatesSocket = new WebSocket('ws://localhost:8081/');
let steamWebPipesWebSocket = new WebSocket('http://localhost:8181/');


export const AuthProvider = function ({ children }) {
    const [state, dispatch] = useReducer(reducer, defaultState);

    // Web worker and socket setup
    useEffect(() => {
        steamWebPipesWebSocket.onmessage = (event) => {
            const { Apps: apps } = JSON.parse(event.data);
            if (apps == null) {
                return;
            }
            const appids = Object.keys(apps);
            for (const appid of appids) {
                if (state.ownedGames[appid] != null) {
                    gameUpdatesWorker.postMessage({ appid, name: state.ownedGames[appid].name });
                }
            }
        };

        steamGameUpdatesSocket.onmessage = (event) => {
            const { appid, events } = JSON.parse(event.data);
            if (state.ownedGames[appid] != null) {
                dispatch({ type: 'addOwnedGamesEvents', value: { [appid]: { name: state.ownedGames[appid].name, events } } });
                dispatch({ type: 'updateGameUpdates', value: appid });
            }
        }

        if (window.Worker) {
            gameDetailsWorker = new Worker(new URL("./workers/gameDetailsWorker.js", import.meta.url));
            gameUpdatesWorker = new Worker(new URL("./workers/gameUpdatesWorker.js", import.meta.url));

            // Set up event listeners for messages from the worker
            gameDetailsWorker.onmessage = function (event) {
                const { ownedGamesWithUpdates, gameUpdatesIDs } = event.data;
                dispatch({ type: 'updateOwnedGames', value: ownedGamesWithUpdates });
                dispatch({ type: 'updateGameUpdates', value: gameUpdatesIDs });
            };

            gameUpdatesWorker.onmessage = function (event) {
                const result = event.data;
                if (result == null) {
                    return;
                }
                const { appid, name, events } = result;
                dispatch({ type: 'addOwnedGamesEvents', value: { [appid]: { name, events } } });
                dispatch({ type: 'updateGameUpdates', value: appid });
            };
            // Clean up the worker when the component unmounts
            return () => {
                gameDetailsWorker.terminate();
                gameUpdatesWorker.terminate();
            };
        } else {
            console.log("This browser doesn't support web workers.");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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

    const getAllUserOwnedGames = async (userID) => {
        const result = await axios.get('api/owned-games', { params: { id: userID } })
        if (result != null) {
            const ownedGames = result?.data?.games?.reduce((acc, game) => {
                // A game's name and events will be entered here later by the worker
                return { ...acc, [game.appid]: {} }
            }, {});
            return ownedGames;
        }
    };

    const fetchMoreUpdates = useCallback(() => {
        gameDetailsWorker.postMessage(state.ownedGames);;
    }, [state.ownedGames]);

    useEffect(() => {
        checkLocalStorage();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (state.id && Object.keys(state.ownedGames).length === 0) {
            (async () => {
                // First grab all a user's owned games
                const ownedGames = await getAllUserOwnedGames(state.id);
                // Then send the owned games to the worker to get their names
                if (ownedGames) {
                    gameDetailsWorker.postMessage(ownedGames);
                }
            })();
        }
    }, [state.id, state.ownedGames]);

    // REMOVE THIS WHEN DEPLOYING
    window.state = state;

    return <AuthContext.Provider
        value={{ ...state, fetchMoreUpdates, dispatch }}
    >
        {children}
    </AuthContext.Provider>
}
