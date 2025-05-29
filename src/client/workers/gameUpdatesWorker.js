import axios from 'axios';

async function getMostRecentUpdatesForGame({ appid, name }) {
    if (appid == null) {
        return null;
    }
    console.log(`Getting most recent updates for game ${appid} (${name})...`);
    try {
        const result = await axios.get('/api/game-updates', { params: { appid } });
        const events = result.data; // an array of events with the bodies

        console.log(`Got ${events.length} updates for game ${appid} (${name})`, events);
        return { appid, name, events };
    } catch (err) {
        console.error(`Getting most recent games' updates failed.`, err);
        return err;
    }
}

onmessage = async function (event) {
    await getMostRecentUpdatesForGame(event.data);
    // const gameInfo = await getMostRecentUpdatesForGame(event.data);
    // postMessage(gameInfo);
};
