import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

// Using self is valid within a web worker.
// eslint-disable-next-line no-restricted-globals
axios.defaults.baseURL = self.location.host.includes('steamgameupdates.info') ?
    'https://api.steamgameupdates.info' :
    (process.env.REACT_APP_LOCALHOST || 'http://localhost') +
    (process.env.REACT_APP_LOCALHOST_PORT || ':8080');
// https://create-react-app.dev/docs/adding-custom-environment-variables/#adding-development-environment-variables-in-env
axios.defaults.withCredentials = true;

onmessage = async ({ data: { ownedGames, totaleNumberOfRequests } }) => {
    let ownedGamesWithoutUpdates = { ...ownedGames };
    let numberOfRequestsSoFar = 1;
    // Remove games that didn't get a name.
    // This happens when a title has been delisted - a name is no longer returned by the API
    const gameIDs = Object.keys(ownedGames);
    if (gameIDs.length === 0) {
        postMessage({ ownedGamesWithUpdates: [], gameUpdatesIDs: [] });
        return;
    }
    const requestSize = 150; // Break up a person's library request into chunks so as not to overwhelm the API
    const requestID = uuidv4();
    try {
        // generate a UUID
        // first post all messages along with this UUID
        // then loop asking for all of the results page per page
        // after the first page returns, emit a result to the main thread but instead of overriding, append on to it.
        // Need to fetch all of them up front, not incrementally
        // because you don't know where the most recently updated game is in the list...
        let result = await axios.post('/api/game-updates-for-owned-games', { appids: gameIDs, request_id: requestID });
        const { gameUpdatesIDs } = result.data;
        postMessage({ gameUpdatesIDs });
        postMessage({ loadingProgress: (++numberOfRequestsSoFar / totaleNumberOfRequests) * 100 });
        do {
            const ownedGamesWithUpdates = {};
            const result = await axios.get('/api/game-updates-for-owned-games',
                { params: { request_id: requestID, requestSize } });
            const { updates, hasMore } = result.data;
            for (const [appid, events] of Object.entries(updates)) {
                ownedGamesWithUpdates[appid] = { ...ownedGamesWithoutUpdates[appid] };
                ownedGamesWithUpdates[appid].events = events;
            }

            // for (const { appid, events } of updates) {
            //     ownedGames[appid].events = events;
            // }
            // postMessage({ loadingProgress: (1 - (gameIDs.length / Object.keys(ownedGames).length)) * 100 });
            postMessage({ loadingProgress: (++numberOfRequestsSoFar / totaleNumberOfRequests) * 100 });
            postMessage({ ownedGamesWithUpdates });
            if (hasMore === false) {
                break;
            }
        } while (true)
        postMessage({ loadingProgress: 100 });
    } catch (err) {
        console.error('Retrieving all game updates failed.', err);
        postMessage(err);
    }
}
