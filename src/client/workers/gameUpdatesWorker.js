import axios from 'axios';

function getMostRecentUpdatesForGame({ appid, name }) {
    if (appid == null) {
        return null;
    }
    console.log(`Getting most recent updates for game ${appid} (${name})...`);
    try {
        axios.post('/api/game-updates', { params: { appid } });
    } catch (err) {
        console.error(`Requesting info about ${appid} (${name}) updates failed.`, err);
        return err;
    }
}

onmessage = async function (event) {
    getMostRecentUpdatesForGame(event.data);
    // const gameInfo = await getMostRecentUpdatesForGame(event.data);
    // postMessage(gameInfo);
};
