import axios from 'axios';

// Using self is valid within a web worker.
// eslint-disable-next-line no-restricted-globals
axios.defaults.baseURL = self.location.host.includes('steamgameupdates.info') ?
    'https://api.steamgameupdates.info' : 'http://localhost:8080';
axios.defaults.withCredentials = true;

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
