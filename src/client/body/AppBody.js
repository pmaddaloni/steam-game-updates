import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../AuthContext';
import styles from './body-styles.module.scss';
import GameUpdateContentComponent from './GameUpdateContentComponent';
import GameUpdateListComponent from './GameUpdateListComponent';

import logo from './steam-logo.svg';

export default function Body() {
    const itemsPerPage = 25;
    const { id, gameUpdates, ownedGames, filteredList } = useAuth();
    const [displayedItems, setDisplayedItems] = useState([]);
    const [startIndex, setStartIndex] = useState(0);
    const [selectedGame, setSelectedGame] = useState(null);
    const timeoutId = useRef(null)
    const gameComponents = useMemo(() => {
        const shownEvents = {};     // {[appid]: # of times it's in the list}
        let index = 0;
        return gameUpdates.map(([, appid]) => {
            const { events, name } = (filteredList ?? ownedGames)[appid] ?? {};
            if (events != null && events.length > 0) {
                shownEvents[appid] = (shownEvents[appid] ?? -1) + 1
                const update = events[shownEvents[appid]];
                return update && (
                    <GameUpdateListComponent
                        eventIndex={shownEvents[appid]}
                        key={appid + '-' + update?.posttime}
                        appid={appid}
                        name={name}
                        update={update}
                        setSelectedGame={setSelectedGame}
                        selectedGame={selectedGame}
                        index={index++}
                    />
                );
            }
            return null;
        }).filter(Boolean).concat(
            <div
                key='filler-list-item'
                className={styles['empty-game']}
            />
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gameUpdates, filteredList]);

    useEffect(() => {
        setSelectedGame(null);
        setDisplayedItems([]);
        setStartIndex(itemsPerPage);
    }, [filteredList]);

    useEffect(() => {
        setDisplayedItems([...gameComponents.slice(0, itemsPerPage)]);
        setStartIndex(itemsPerPage);
    }, [gameComponents]);

    useEffect(() => {
        if (gameUpdates.length === 0) {
            setSelectedGame(null);
        }
    }, [gameUpdates]);

    useEffect(() => {
        const previousSelectedGame = document.getElementsByClassName(styles.selected)[0];
        if (previousSelectedGame) {
            previousSelectedGame.classList.remove(styles.selected);
        }
        const selectedGameComponent = document.getElementById(selectedGame?.index);
        if (selectedGameComponent) {
            selectedGameComponent.classList.add(styles.selected);
            if (document.body.style.pointerEvents === 'none') {
                selectedGameComponent.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center',
                });
            }
        }
        const element = document.getElementById('update-content');
        if (element) {
            element.style.transition = null;
            element.style.opacity = 0;
        }
    }, [selectedGame]);

    function showCursor() {
        document.body.style.pointerEvents = 'all';
    }

    const handleKeyDown = useCallback((event) => {
        document.body.style.pointerEvents = 'none';

        // Use a ref for timeoutId to persist across renders
        if (timeoutId.current) {
            clearTimeout(timeoutId.current);
            timeoutId.current = null;
        }
        timeoutId.current = setTimeout(showCursor, 5000);

        const selectedIndex = selectedGame?.index ?? -1;
        let newIndex = selectedIndex;
        if (event.key === 'ArrowUp') {
            newIndex = selectedIndex > 0 ? selectedIndex - 1 : 0;
        } else if (event.key === 'ArrowDown') {
            newIndex = selectedIndex < displayedItems.length - 1 ? selectedIndex + 1 : selectedIndex;
        }

        if (newIndex !== selectedIndex) {
            const newSelectedGame = displayedItems.find(item => item.props.index === newIndex);
            if (newSelectedGame) {
                const { props: { appid, eventIndex, index } } = newSelectedGame;
                const update = ownedGames[appid].events[eventIndex];
                setSelectedGame({ appid, update, index });
            }
        }
    }, [displayedItems, ownedGames, selectedGame]);

    useEffect(() => {
        document.addEventListener('mousemove', () => {
            showCursor();
            clearTimeout(timeoutId.current);
            timeoutId.current = null;
        })
        window.addEventListener('keydown', handleKeyDown);

        return () => {
            document.removeEventListener('mousemove', showCursor);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [displayedItems, handleKeyDown, ownedGames, selectedGame]);

    const handleScroll = () => {
        const gameList = document.getElementById('game-list');
        const isAtBottom = gameList.scrollTop + gameList.clientHeight >= gameList.scrollHeight - 200;
        if (isAtBottom /* && !isLoading */) {
            const nextIndex = startIndex + itemsPerPage;
            const nextItems = [...gameComponents.slice(startIndex, nextIndex)];
            setStartIndex(nextIndex);
            setDisplayedItems([...displayedItems, ...nextItems]);
        }
    };

    useEffect(() => {
        const gameList = document.getElementById('game-list');
        if (gameList == null) {
            return;
        }

        gameList.addEventListener('scroll', handleScroll);
        return () => {
            gameList.removeEventListener('scroll', handleScroll);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [displayedItems]);

    return (
        <div className={styles["app-body"]} >
            {Object.keys(gameUpdates).length === 0 ?
                <div className={styles['loading-container']}>
                    <img src={logo} className="App-logo" alt="logo" />
                    <p>
                        {id === '' ?
                            <>
                                Log in to see all updates for your owned Steam games.
                                <br />
                                <small><b>**</b>Your Steam profile must be public for this to work.<b>**</b></small>
                            </>
                            :
                            <>Gathering patch notes for your owned games - hang tight...</>
                        }
                    </p>
                </div> :
                <>
                    <div className={styles.container}>
                        <div id="game-list" className={styles['game-list']}>
                            <div className={styles['game-list-header']}>
                                <div className={styles['patch-title-header']}>Date</div>
                                <div className={styles['patch-title-header']}>Game</div>
                                <div className={styles['patch-title-header']}>Title</div>
                            </div>
                            {displayedItems}
                        </div>
                        <div className={styles['update-container']}>
                            <div className={styles["container-header"]}>
                                <div className={styles['update']}>Update</div>
                            </div>
                            <div
                                id='update-content'
                                data-gid={selectedGame?.update?.gid ?? ''}
                                className={styles['update-content']}
                            >{
                                    selectedGame != null ?
                                        <GameUpdateContentComponent
                                            appid={selectedGame.appid}
                                            update={selectedGame.update}
                                            name={ownedGames[selectedGame.appid].name}
                                        />
                                        :
                                        'Click or use the keyboard to see a game\'s update details!'
                                }
                            </div>
                        </div>
                    </div>
                </>
            }
        </div >
    );
}
