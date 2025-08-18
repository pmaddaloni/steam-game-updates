import axios from 'axios';
import { useEffect, useReducer, useState } from 'react';
import Switch from "react-switch";
import { Popover } from 'react-tiny-popover';
import LoadingBar from "react-top-loading-bar";

import classNames from 'classnames';
import { useAuth } from '../AuthContext.js';
import styles from './header-styles.module.scss';
import steamGameUpdatesImg from './steam-game-updates.svg';

const baseURL = window.location.host.includes('steamgameupdates.info') ?
    'https://api.steamgameupdates.info' :
    (process.env.REACT_APP_LOCALHOST || 'http://localhost') +
    (process.env.REACT_APP_LOCALHOST_PORT || ':8080');
const loginLocation = baseURL + "/api/login";

const popoverStyle = {
    opacity: '0',
    transition: 'opacity 200ms',
    color: 'white',
    backgroundColor: '#32414c',
    padding: '10px',
    border: ' rgb(128, 128, 128) 1px solid',
    borderRadius: '4px',
    fontFamily: '"Open Sans", sans-serif',
    boxShadow: '-4px 8px 24px #959da533',
    listStyle: 'none',
    minWidth: '220px',
};

const listItemStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    margin: '5px 0px',
    transition: 'color 300ms',
    userSelect: 'none'
}

const buttonStyle = {
    appearance: 'none',
    background: 'none',
    border: 'none',
    font: 'inherit',
    color: 'white',
    textDecoration: 'underline',
    padding: '0',
    cursor: 'pointer',
    display: 'inline',
    transition: 'color 300ms',
}

const buttonStyleDisabled = {
    appearance: 'none',
    background: 'none',
    border: 'none',
    font: 'inherit',
    color: 'white',
    textDecoration: 'underline',
    padding: '0',
    cursor: 'default',
    display: 'inline',
    pointerEvents: 'none',
    opacity: '0.5',
}

const listItemSwitchProps = {
    onColor: "#86d3ff",
    onHandleColor: "#2693e6",
    uncheckedIcon: false,
    checkedIcon: false,
    boxShadow: "0px 1px 5px rgba(0, 0, 0, 0.6)",
    activeBoxShadow: "0px 0px 1px 10px rgba(0, 0, 0, 0.2)",
    handleDiameter: 12,
    height: 7,
    width: 25,
    className: "react-switch",
    id: "material-switch",
    onChange: () => null
}

const dividerStyle = {
    height: '1px',
    backgroundColor: 'rgb(128, 128, 128)',
    margin: '10px 0',
    width: '100%',
};

const listItemProps = {
    onMouseOver: e => {
        e.target.style.color = '#5fb4f0';
        e.target.style.cursor = 'pointer';
    },
    onMouseOut: e => e.target.style.color = 'white'
}

const defaultFilters = {
    major: true,
    minor: true,
    gameEvents: true,
    newsEvents: true,
    crossPosts: true,
    allOtherEvents: true,
}

const reducer = (state, filterToUpdate) => {
    if (filterToUpdate === 'none' || filterToUpdate === 'all') {
        return Object.keys(defaultFilters).reduce((acc, key) => {
            return { ...acc, [key]: filterToUpdate === 'all' }
        }, {})
    }
    return { ...state, [filterToUpdate]: !state[filterToUpdate] };
}

export default function Header() {
    const { notificationsAllowed, id: userID, displayName, photos, dispatch, menuFilters, loadingProgress } = useAuth();
    const [interactionDisabled, setInteractionDisabled] = useState(true);
    const [searchValue, setSearchValue] = useState('');
    const [allowNotifications, setAllowNotifications] = useState(notificationsAllowed);
    const [isPopoverOpen, setIsOpen] = useState(false);
    const [filters, filtersDispatch] = useReducer(reducer, defaultFilters)
    const dispatchFilterChanges = type => dispatch({ type: 'updateFilters', value: type });

    useEffect(() => {
        (menuFilters).forEach(f => filtersDispatch(f))
    }, [menuFilters])

    useEffect(() => {
        setInteractionDisabled(loadingProgress < 100);
        if (searchValue && loadingProgress == null) {
            setSearchValue('');
            scrollToTopOfList(searchValue);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loadingProgress])

    useEffect(() => {
        if (notificationsAllowed !== allowNotifications) {
            setAllowNotifications(notificationsAllowed);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [notificationsAllowed]);

    useEffect(() => {
        function handleKeyDown(event) {
            if (interactionDisabled) {
                return;
            }
            const searchBar = document.getElementById('search-bar');
            if (event.key === 'r' && document.activeElement !== searchBar) {
                const refreshButton = document.getElementById('refresh-button');
                if (refreshButton) {
                    refreshButton.classList.add(styles['pseudo-active']);
                    setTimeout(() => refreshButton.classList.remove(styles['pseudo-active']), 200);
                }
                dispatch({ type: 'refreshGames' })
            } else if (event.key === 's' && document.activeElement !== searchBar) {
                event.preventDefault();
                searchBar?.focus()
            }
        };
        if (userID !== '') {
            window.addEventListener('keydown', handleKeyDown);
        }
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [dispatch, interactionDisabled, userID]);

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
        if (window.confirm('Are you sure you want to log out?')) {
            dispatch({ type: 'logout' });
        }
    };

    const scrollToTopOfList = (value, target) => {
        if (target) {
            target.blur();
        }
        const gameList = document.getElementById("game-list");
        gameList?.scrollTo({
            top: -100,
            behavior: 'instant',
        });
        setTimeout(dispatch({ type: 'updateSearch', value }), 2000)
    }

    const shouldShowPopup = (shouldShow) => {
        if (shouldShow) {
            setIsOpen(true);
            setTimeout(() => {
                const element = document.getElementById('popover-menu');
                if (element)
                    element.style.opacity = 1;
            }, 90);
        } else {
            const element = document.getElementById('popover-menu');
            element.style.opacity = 0;
            setTimeout(() => {
                setIsOpen(false);
            }, 200)
        }
    }

    const filterLabels = [
        ['Major Updates', 'major'],
        ['Minor Updates', 'minor'],
        ['Game Events', 'gameEvents'],
        ['News Events', 'newsEvents'],
        ['Cross Posts', 'crossPosts'],
        ['All Other Events', 'allOtherEvents'],
    ];
    const allButtonDisabled = Object.values(filters).every(filter => filter === true);

    return (
        <>
            <div className={styles.header}>
                <div>
                    <img className={styles['header-img']} src={steamGameUpdatesImg} alt="steam game updates logo" />
                    <div>Steam Game Updates</div>
                </div>
                {userID !== '' &&
                    <div className={styles['input-container']}>
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
                            onFocus={e => e.target.select()}
                            value={searchValue}
                            onChange={({ target }) => {
                                setSearchValue(target.value);
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
                            onClick={() => dispatch({ type: 'refreshGames' })}
                        >Refresh Games</button>
                    </div>
                }
                {userID !== '' ?
                    <Popover
                        isOpen={isPopoverOpen}
                        positions={['bottom']}
                        onClickOutside={() => shouldShowPopup(false)}
                        transform={{ left: -20 }}
                        transformMode='relative'
                        reposition={true}
                        containerStyle={{ position: 'fixed', zIndex: '1000000000' }}
                        content={() => (
                            <ul
                                id="popover-menu"
                                style={{ ...popoverStyle }}
                            >
                                <li style={listItemStyle}
                                    onClick={async () => {
                                        let allow = !allowNotifications;
                                        if (Notification.permission === "default") {
                                            const permission = await Notification.requestPermission();
                                            allow = permission === "granted";
                                        } else if (allow && Notification.permission === "denied") {
                                            window.alert("You have denied notifications. Please enable them in your browser settings to receive updates.");
                                            allow = false;
                                        }
                                        setAllowNotifications(allow);
                                        dispatch({ type: 'setNotificationsAllowed', value: allow });
                                    }}
                                    {...listItemProps}
                                >
                                    Allow notifications
                                    <Switch
                                        checked={allowNotifications}
                                        {...listItemSwitchProps}
                                    />
                                </li>
                                <li style={{ ...dividerStyle }} />
                                <li style={{
                                    fontSize: '12px',
                                    fontWeight: 'bold',
                                    marginBottom: '10px',
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    userSelect: 'none'
                                }}>
                                    Show:
                                    <div>
                                        <button
                                            {...listItemProps}
                                            disabled={allButtonDisabled}
                                            style={{ ...(allButtonDisabled ? buttonStyleDisabled : buttonStyle), marginRight: '5px' }}
                                            onClick={() => {
                                                filtersDispatch('all');
                                                dispatchFilterChanges('all');
                                            }}
                                        >
                                            all
                                        </button>
                                    </div>
                                </li>
                                {filterLabels.map(([title, key]) => (
                                    <li style={listItemStyle}
                                        onClick={() => {
                                            const newFilter = !filters[key];
                                            if (Object.values(filters).filter(Boolean).length === 1 && newFilter === false) {
                                                window.alert('Cannot disable all filters. You must have at least one filter enabled.')
                                                return;
                                            } else {
                                                filtersDispatch(key);
                                                dispatchFilterChanges(key);
                                            }
                                        }}
                                        {...listItemProps}
                                    >
                                        {title}
                                        <Switch
                                            checked={filters[key]}
                                            {...listItemSwitchProps}
                                        />
                                    </li>
                                ))}
                                <li style={{ ...dividerStyle }} />
                                <li
                                    style={{ ...listItemStyle, display: 'flex', justifyContent: 'space-between', cursor: 'default' }}
                                >
                                    <div
                                        style={{ transition: 'color 300ms' }}
                                        {...listItemProps} onClick={() => logout()}>Logout</div>
                                    <div
                                        onClick={() => window.open('https://ko-fi.com/mondobodacious', '_blank')}
                                        style={{
                                            backgroundColor: '#00b4f7',
                                            borderRadius: '100px',
                                            height: '26px',
                                            display: 'flex',
                                            alignItems: 'center',
                                            fontFamily: "'Nunito', 'Quicksand', sans-serif",
                                            fontSize: '16px',
                                            width: 'max-content',
                                            color: '#fff',
                                            justifyContent: 'space-between',
                                            padding: '0 10px',
                                            fontWeight: 'bold',
                                            cursor: 'pointer',
                                        }}>
                                        <img style={{ width: '24px' }} src="https://storage.ko-fi.com/cdn/cup-border.png" alt="ko-fi" />
                                        <span style={{ fontSize: '9px', marginLeft: "8px", color: "#323842" }}>Enjoying?<br />Many Thanks!</span>
                                    </div>
                                </li>
                            </ul>
                        )}
                    >
                        <div className={classNames(interactionDisabled ? styles['menu-disabled'] : null, isPopoverOpen ? styles.active : null, styles.menu)} onClick={() => shouldShowPopup(!isPopoverOpen)}>
                            <img src={photos[0]?.value} alt='user-avatar' />
                            <div className={styles.user} >{displayName}</div>
                            <div className={styles['menu-caret']}>&#x2304;</div>
                        </div>
                    </Popover>
                    : <button className={styles.login} onClick={login} />
                }
            </div>
            <LoadingBar
                containerStyle={{ top: "46px" }}
                shadowStyle={{ display: 'none' }}
                color="rgb(0, 175, 244)"
                height={4}
                progress={loadingProgress}
            />
        </>
    );
}
