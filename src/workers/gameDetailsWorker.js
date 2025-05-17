import axios from 'axios';

async function getMostRecentUpdates(ownedGames) {
    const gameIDs = Object.keys(ownedGames);
    const gameIDsToBeFetchedSize = 500; // Break up a person's library into chunks of 500 so as not to overwhelm the API

    try {
        let gameUpdatesTimes = [];
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
            const { updates, /* page */ } = result.data;
            const filteredUpdates = updates.filter(({ mostRecentUpdateTime }) => mostRecentUpdateTime != null)
            // An array of {appid: gameID, events: []} in order of updates is returned
            // Remove the appids in the result from the gameIDs for pagination purposes
            // return the filtered gameIDs, updates to the context.

            for (const { appid: gameID, events, mostRecentUpdateTime } of filteredUpdates) {
                if (events) {
                    ownedGames[gameID].events = events;
                    gameUpdatesTimes.push([mostRecentUpdateTime, gameID]);
                }
            }
        } while (gameIDs.length > 0)
        gameUpdatesTimes = gameUpdatesTimes.sort((a, b) => b[0] - a[0]);
        return { ownedGamesWithUpdates: ownedGames, gameUpdatesIDs: gameUpdatesTimes.map(([, appid]) => appid) };
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
