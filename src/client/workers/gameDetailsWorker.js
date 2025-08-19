import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { getClientInfo, SUBSCRIPTION_BROWSER_ID_SUFFIX } from '../../utilities/utils.js';

// Using self is valid within a web worker.
// eslint-disable-next-line no-restricted-globals
axios.defaults.baseURL = self.location.host.includes('steamgameupdates.info') ?
    'https://api.steamgameupdates.info' :
    (process.env.REACT_APP_LOCALHOST || 'http://localhost') +
    (process.env.REACT_APP_LOCALHOST_PORT || ':8080');
// https://create-react-app.dev/docs/adding-custom-environment-variables/#adding-development-environment-variables-in-env
axios.defaults.withCredentials = true;
const CLIENT_INFO = `${SUBSCRIPTION_BROWSER_ID_SUFFIX}: ${getClientInfo().browser}`;

onmessage = async ({ data: {
    ownedGames,
    totalNumberOfRequests,
    requestSize,
    id,
    filters,
    retrievalAmount
} }) => {
    let ownedGamesWithoutUpdates = { ...ownedGames };
    let numberOfRequestsSoFar = 1;
    // Remove games that didn't get a name.
    // This happens when a title has been delisted - a name is no longer returned by the API
    const appids = Object.keys(ownedGames);
    if (appids.length === 0) {
        postMessage({ ownedGamesWithUpdates: {}, gameUpdatesIDs: [] });
        return;
    }

    const requestID = uuidv4();
    // const loadingThreshold = 4;
    try {
        // generate a UUID
        // first post all messages along with this UUID
        // then loop asking for all of games bit by bit
        // after the first page returns, emit a result to the main thread but instead of overriding, append on to it.
        // Need to fetch all of them up front, not incrementally
        // because you don't know where the most recently updated game is in the list...
        let result = await axios.post('/api/beta/game-updates-for-owned-games', {
            appids, request_id: requestID, id: id + CLIENT_INFO, filters, request_size: retrievalAmount
        });
        const { gameUpdatesIDs } = result.data;
        postMessage({ gameUpdatesIDs });
        postMessage({ loadingProgress: (++numberOfRequestsSoFar / totalNumberOfRequests) * 100 });
        let ownedGamesWithUpdates = {};
        do {
            // if (numberOfRequestsSoFar < loadingThreshold) {
            //     ownedGamesWithUpdates = {};
            // }
            const result = await axios.get('/api/beta/game-updates-for-owned-games',
                { params: { request_id: requestID, fetch_size: requestSize } });
            const { updates, hasMore } = result.data;
            for (const [appid, events] of Object.entries(updates)) {
                ownedGamesWithUpdates[appid] = { ...ownedGamesWithoutUpdates[appid] };
                ownedGamesWithUpdates[appid].events = events;
            }
            postMessage({ loadingProgress: (++numberOfRequestsSoFar / totalNumberOfRequests) * 100 });
            // if (numberOfRequestsSoFar < loadingThreshold) {
            postMessage({ ownedGamesWithUpdates });
            // }
            if (hasMore === false) {
                break;
            }
        } while (numberOfRequestsSoFar !== totalNumberOfRequests)
        postMessage({ loadingProgress: 100 });
        postMessage({ ownedGamesWithUpdates });
    } catch (err) {
        console.error('Retrieving all game updates failed.', err);
        postMessage(err);
    }
}
