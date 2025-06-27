import dotenv from 'dotenv';
dotenv.config();

const config = {
    PORT: process.env.PORT,
    STEAM_API_KEY: process.env.STEAM_API_KEY,
    STEAM_GAME_UPDATES_SECRET: process.env.STEAM_GAME_UPDATES_SECRET,
    ENVIRONMENT: process.env.NODE_ENV || 'development',
};

export default config;
