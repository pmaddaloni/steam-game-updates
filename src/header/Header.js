import axios from 'axios';

import { useAuth } from '../AuthContext';
import styles from './header-styles.module.scss';

const loginLocation = "http://localhost:8080/auth/steam";
const logoutLocation = "http://localhost:8080/logout";

export default function Header() {
    const { id: userID, displayName, photos, dispatch } = useAuth();

    const login = async () => {
        const newWindow = window.open(loginLocation, 'Steam Sign-in',
            'menubar=1,resizable=1,width=500,height=700');
        if (newWindow) {
            const timer = setInterval(async () => {
                if (newWindow.closed) {
                    clearInterval(timer);
                    const result = await axios.get('/api/user');
                    if (result?.data) {
                        localStorage.setItem('steam-game-updates-user', JSON.stringify(result.data));
                        dispatch({ type: 'login', value: result.data });
                    }
                }
            }, 500);
        } else {
            // TODO: Report error to user
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
            {userID !== '' ?
                <div className={styles.menu} >
                    <img src={photos[0]?.value} alt='user-avatar' />
                    <div onClick={logout}>{displayName}</div>
                </div>
                : <button className={styles.login} onClick={login} />}
        </div>
    );
}
