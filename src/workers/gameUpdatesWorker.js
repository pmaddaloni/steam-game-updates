import axios from 'axios';

async function getMostRecentUpdatesForGame({ appid, name }) {
    if (appid == null) {
        return null;
    }
    console.log(`Getting most recent updates for game ${appid} (${name})...`);
    try {
        const result = await axios.get('/api/game-updates', { params: { appid } });
        const gameUpdates = result.data; // an array of events with the bodies

        console.log(`Got ${gameUpdates.length} updates for game ${appid} (${name})`, gameUpdates);
        return { appid, name, events: gameUpdates };
    } catch (err) {
        console.error(`Getting most recent games' updates failed.`, err);
        return err;
    }
}

onmessage = async function (event) {
    const updates = await getMostRecentUpdatesForGame(event.data);
    postMessage(updates);
};
