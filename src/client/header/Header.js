import axios from 'axios';
import { useEffect, useState } from 'react';

import { useAuth } from '../AuthContext';
import styles from './header-styles.module.scss';
import steamGameUpdatesImg from './steam-game-updates.svg';

const baseURL = window.location.host.includes('steamgameupdates.info') ?
    'https://api.steamgameupdates.info' : 'http://192.168.110.89:8080';
const loginLocation = baseURL + "/api/login";
const logoutLocation = baseURL + "/api/logout";

export default function Header() {
    const { id: userID, displayName, photos, dispatch, gameUpdates } = useAuth();
    const [interactionDisabled, setInteractionDisabled] = useState(true);

    const login = async () => {
        const newWindow = window.open(loginLocation, 'Steam Sign-in',
            'menubar=1,resizable=1,width=500,height=1000');
        if (newWindow) {
            const timer = setInterval(async () => {
                if (newWindow.closed) {
                    clearInterval(timer);
                    try {
                        const result = await axios.get('/api/user');
                        if (result?.data) {
                            localStorage.setItem('steam-game-updates-user', JSON.stringify(result.data));
                            dispatch({ type: 'login', value: result.data });
                        }
                    } catch (err) {
                        console.error("Error fetching user data after login:", err);
                    }
                }
            }, 500);
        } else {
            alert("Failed to open new window to sign in to Steam. Please check your browser settings or popup blockers.");
            console.error("Failed to open new window. Please check your browser settings or popup blockers.");
        }
    };

    const logout = () => {
        localStorage.removeItem('steam-game-updates-user');
        dispatch({ type: 'logout' });
        window.open(logoutLocation, 'Steam Sign-out',
            'menubar=1,resizable=1,width=500,height=700');
    };

    const refreshGames = async () => {
        try {
            const result = await axios.get('/api/user');
            if (result?.data) {
                dispatch({ type: 'refreshGames' })
            }
        } catch (e) {
            alert('Your login has expired. Please log in again.');
            logout();
        }
    };

    const scrollToTopOfList = (value, target) => {
        if (target) {
            target.blur();
        }
        const searchBar = document.getElementById("game-list");
        searchBar?.scrollTo({
            top: -100,
            behavior: 'instant',
        });
        setTimeout(dispatch({ type: 'updateSearch', value }), 2000)
    }

    useEffect(() => {
        setInteractionDisabled(gameUpdates.length === 0);
    }, [gameUpdates])

    useEffect(() => {
        function handleKeyDown(event) {
            const searchBar = document.getElementById('search-bar');
            if (event.key === 'r' && document.activeElement !== searchBar) {
                const refreshButton = document.getElementById('refresh-button');
                refreshButton.classList.add(styles['pseudo-active']);
                setTimeout(() => refreshButton.classList.remove(styles['pseudo-active']), 200);
                refreshGames();
            } else if (event.key === 's' && document.activeElement !== searchBar) {
                event.preventDefault();
                searchBar?.focus()
            }
        };
        window.addEventListener('keydown', handleKeyDown);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, []);

    return (
        <div className={styles.header}>
            <div>
                <img className={styles['header-img']} src={steamGameUpdatesImg} alt="steam game updates logo" />
                <div>Steam Game Updates</div>
            </div>
            {userID !== '' &&
                <>
                    <input
                        title="Press the 's' hotkey to start searching"
                        id="search-bar"
                        placeholder='Search your updates by game title...'
                        disabled={interactionDisabled}
                        autoComplete="off"
                        autoCapitalize="off"
                        className={styles.search}
                        type="text"
                        name="search"
                        maxLength="100"
                        size="100"
                        onFocus={e => e.target.select()}
                        onChange={({ target }) => {
                            if (target.value === '') {
                                scrollToTopOfList(target.value, target);
                            }
                        }}
                        onBlur={({ target }) => {
                            scrollToTopOfList(target.value);
                        }}
                        onKeyUp={({ code, target }) => {
                            if (code === 'Enter') {
                                scrollToTopOfList(target.value, target);
                            }
                        }}
                    />
                    <button
                        title="Press the 'r' hotkey to refresh your updates"
                        id="refresh-button"
                        disabled={interactionDisabled}
                        className={styles.refreshGames}
                        onClick={refreshGames}
                    >Refresh Games</button>
                </>
            }
            {userID !== '' ?
                <div className={styles.menu} >
                    <img src={photos[0]?.value} alt='user-avatar' />
                    <div className={styles.user} onClick={logout}>{displayName}</div>
                    <div className={styles.logout} onClick={logout}>Logout?</div>
                </div>
                : <button className={styles.login} onClick={login} />
            }
        </div>
    );
}
