import axios from 'axios';

// Using self is valid within a web worker.
// eslint-disable-next-line no-restricted-globals
axios.defaults.baseURL = self.location.host.includes('steamgameupdates.info') ?
    'https://steamgameupdates.info' :
    (process.env.REACT_APP_LOCALHOST || 'http://localhost') +
    (process.env.REACT_APP_LOCALHOST_PORT || ':8080');
// https://create-react-app.dev/docs/adding-custom-environment-variables/#adding-development-environment-variables-in-env
axios.defaults.withCredentials = true;
axios.defaults.maxRedirects = 0; // Set to 0 to prevent automatic redirects
axios.interceptors.response.use(
    response => response,
    error => {
        if (error.response && [301, 302].includes(error.response.status)) {
            const redirectUrl = error.response.headers.location;
            return axios[error.config.method](redirectUrl);
        }
        return Promise.reject(error);
    }
);

async function getMostRecentUpdates(ownedGames) {
    const gameIDs = Object.keys(ownedGames);
    const gameIDsToBeFetchedSize = 500; // Break up a person's library into chunks of 500 so as not to overwhelm the API
    postMessage({ loadingProgress: 0 });
    try {
        let gameUpdatesIDs = [];
        do {
            const gameIDsToBeFetched = gameIDs
                .splice(0, gameIDsToBeFetchedSize);
            // Need to fetch all of them up front, not incrementally
            // because you don't know where the most recently updated game is in the list...
            const result = await axios.get('/api/game-updates-for-owned-games',
                {
                    params: { appids: gameIDsToBeFetched, },
                    paramsSerializer: { indexes: true }     // i.e. use brackets with indexes
                });
            const { updates } = result.data;
            const filteredUpdates = updates.filter(({ events }) => events?.length > 0);
            // Sort the updates for each game by posttime, descending
            for (const { appid, events } of filteredUpdates) {
                ownedGames[appid].events = events;
                gameUpdatesIDs = gameUpdatesIDs.concat(
                    events.map(({ posttime }) => [posttime, appid]));
            }
            postMessage({ loadingProgress: (1 - (gameIDs.length / Object.keys(ownedGames).length)) * 100 });
        } while (gameIDs.length > 0)
        gameUpdatesIDs = gameUpdatesIDs.sort((a, b) => b[0] - a[0]);
        return { ownedGamesWithUpdates: ownedGames, gameUpdatesIDs };
    } catch (err) {
        return { err };
    }
}

onmessage = async (event) => {
    let ownedGames = { ...event.data };
    // Remove games that didn't get a name from above.
    // This happens when a title has been delisted - a name is no longer returned by the API
    ownedGames = Object.fromEntries(Object.entries(ownedGames).filter(([, v]) => Object.keys(v).length > 0))
    try {
        const { ownedGamesWithUpdates, gameUpdatesIDs, err } = await getMostRecentUpdates(ownedGames);
        if (err) {
            console.error('Getting most recent games\' updates failed.', err);
            postMessage(err);
        } else {
            postMessage({ ownedGamesWithUpdates, gameUpdatesIDs });
        }
    } catch (err) {
        console.error('Retrieving all games from Steam API failed.', err);
        postMessage(err);
    }
}
