import axios from 'axios';

async function getMostRecentUpdates(ownedGames) {
    const gameIDs = Object.keys(ownedGames);
    const gameIDsToBeFetchedSize = 500; // Break up a person's library into chunks of 500 so as not to overwhelm the API

    try {
        let gameUpdateTimes = [];
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
            for (const { appid, events } of filteredUpdates) {
                ownedGames[appid].events = events;
                gameUpdateTimes = gameUpdateTimes.concat(
                    events.map(({ posttime }) => [posttime, appid]));
            }
        } while (gameIDs.length > 0)
        gameUpdateTimes = gameUpdateTimes.sort((a, b) => b[0] - a[0]);
        return { ownedGamesWithUpdates: ownedGames, gameUpdatesIDs: gameUpdateTimes };
    } catch (err) {
        return { err };
    }
}

onmessage = (event) => {
    axios.get('/api/all-steam-games').then(async ({ data: allGames }) => {
        let ownedGames = { ...event.data };

        let numberOfGames = Object.keys(ownedGames).length
        for (let { appid, name } of allGames) {
            if (Object.hasOwn(ownedGames, appid)) {
                ownedGames[appid].name = name;
                numberOfGames--;
            }
            // All games have been matched; no need to continue.
            if (numberOfGames === 0) {
                break;
            }
        }
        // Remove games that didn't get a name from above.
        // This happens when a title has been delisted - a name is no longer returned by the API
        ownedGames = Object.fromEntries(Object.entries(ownedGames).filter(([, v]) => Object.keys(v).length > 0))
        const { ownedGamesWithUpdates, gameUpdatesIDs, err } = await getMostRecentUpdates(ownedGames);
        if (err) {
            console.error('Getting most recent games\' updates failed.', err);
            postMessage(err);
        } else {
            postMessage({ ownedGamesWithUpdates, gameUpdatesIDs });
        }
    }).catch(err => {
        console.error('Retrieving all games from Steam API failed.', err);
        postMessage(err);
    })
}
