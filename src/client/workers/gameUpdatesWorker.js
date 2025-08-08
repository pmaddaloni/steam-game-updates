import axios from 'axios';

// eslint-disable-next-line no-restricted-globals
axios.defaults.baseURL = self.location.host.includes('steamgameupdates.info') ?
    'https://api.steamgameupdates.info' :
    (process.env.REACT_APP_LOCALHOST || 'http://localhost') +
    (process.env.REACT_APP_LOCALHOST_PORT || ':8080');
// https://create-react-app.dev/docs/adding-custom-environment-variables/#adding-development-environment-variables-in-env
axios.defaults.withCredentials = true;

const requestQueue = [];
const delayInMs = 1000;
let isProcessing = false;

async function queueMostRecentUpdatesForGame({ appid, name }) {
    if (appid == null) {
        return null;
    }
    try {
        await axios.post('/api/game-updates', { appid });
    } catch (err) {
        console.error(`Requesting info about ${appid} (${name}) updates failed.`, err);
        return err;
    }
}

const processQueue = async () => {
    if (isProcessing || requestQueue.length === 0) {
        isProcessing = false;
        return;
    }

    isProcessing = true;
    const call = requestQueue.shift();

    try {
        await call();
    } catch (err) {
        console.error("Failed to execute call from queue.", err);
    }

    if (requestQueue.length > 0) {
        setTimeout(() => processQueue(), delayInMs);
    } else {
        isProcessing = false;
    }
};

onmessage = async ({ data: { appid, name } }) => {
    if (requestQueue.some(({ appid: id }) => appid === id)) {
        return;
    }

    requestQueue.push((() => queueMostRecentUpdatesForGame({ appid, name })));

    if (!isProcessing) {
        processQueue();
    }
}
