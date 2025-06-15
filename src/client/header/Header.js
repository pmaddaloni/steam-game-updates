import axios from 'axios';
import { useEffect, useState } from 'react';

import { useAuth } from '../AuthContext';
import styles from './header-styles.module.scss';

const loginLocation = "http://localhost:8080/auth/steam";
const logoutLocation = "http://localhost:8080/logout";

export default function Header() {
    const { id: userID, displayName, photos, dispatch, gameUpdates } = useAuth();
    const [refreshDisabled, setRefreshDisabled] = useState(true);

    useEffect(() => {
        setRefreshDisabled(gameUpdates.length === 0);
    }, [gameUpdates])

    const login = async () => {
        const newWindow = window.open(loginLocation, 'Steam Sign-in',
            'menubar=1,resizable=1,width=500,height=700');
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
        window.open(logoutLocation, 'Steam Sign-in',
            'menubar=1,resizable=1,width=500,height=700');
    };

    return (
        <div className={styles.header}>
            <div>Steam Game Updates</div>
            {userID !== '' &&
                <button
                    disabled={refreshDisabled}
                    className={styles.refreshGames}
                    onClick={() => {
                        dispatch({ type: 'refreshGames' })
                    }}
                >Refresh Games</button>
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
