import dotenv from 'dotenv';
dotenv.config();

const config = {
    PORT: process.env.PORT,
    STEAM_API_KEY: process.env.STEAM_API_KEY,
    STEAM_GAME_UPDATES_SECRET: process.env.STEAM_GAME_UPDATES_SECRET,
    HOST_ORIGIN: process.env.REACT_APP_LOCALHOST,
    ENVIRONMENT: process.env.NODE_ENV || 'development',
    SSL_KEY_PATH: process.env.SSL_KEY_PATH || './ssl/key.pem',
    SSL_CERT_PATH: process.env.SSL_CERT_PATH || './ssl/cert.pem',
    ONE_SIGNAL_APP_ID: process.env.ONE_SIGNAL_APP_ID,
    ONE_SIGNAL_REST_API_KEY: process.env.ONE_SIGNAL_REST_API_KEY,
};

export default config;
