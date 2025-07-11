import axios from 'axios';

// Using self is valid within a web worker.
// eslint-disable-next-line no-restricted-globals
axios.defaults.baseURL = self.location.host.includes('steamgameupdates.info') ?
    'https://api.steamgameupdates.info' : (process.env.REACT_APP_LOCALHOST || 'http://localhost') + ':8080';
// https://create-react-app.dev/docs/adding-custom-environment-variables/#adding-development-environment-variables-in-env
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
