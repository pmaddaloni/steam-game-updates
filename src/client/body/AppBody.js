import { cloneElement, useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../AuthContext.js';
import styles from './body-styles.module.scss';
import GameUpdateContentComponent from './GameUpdateContentComponent.js';
import GameUpdateListComponent from './GameUpdateListComponent.js';

import logo from './steam-logo.svg';

export default function Body() {
    const itemsPerPage = 25;
    const { id, gameUpdates, ownedGames, filteredList, filters, loadingProgress } = useAuth();
    const [selectedGame, setSelectedGame] = useState(null);
    const [gameComponents, setGameComponents] = useState([]);
    const currentListIndexRef = useRef(0);
    const currentGameComponentsRef = useRef([]);
    const gameUpdatesRef = useRef(null);
    const timeoutId = useRef(null);

    const createGameComponents = useCallback((gamesList, showMore = false) => {
        let componentIndex = showMore ? currentGameComponentsRef.current.length : 0;
        let currentIndex = showMore ? currentListIndexRef.current : 0;
        const gamesArray = gamesList.slice(currentIndex);
        const newList = [];
        for (const [posttime, appid] of gamesArray) {
            currentIndex++;
            if (ownedGames[appid] == null) {
                continue;
            }

            const { events, name } = ownedGames[appid];
            const updateIndex = events.findIndex(({ posttime: eventPosttime }) => posttime === eventPosttime);
            const update = events[updateIndex];
            if (filters.includes(update.event_type)) {
                continue;
            }

            if (update != null) {
                newList.push(<GameUpdateListComponent
                    key={appid + '-' + update.posttime}
                    appid={appid}
                    name={name}
                    update={update}
                    setSelectedGame={setSelectedGame}
                    index={componentIndex++}
                    eventIndex={updateIndex}
                />);
            }
            if (newList.length === itemsPerPage) {
                break;
            }
        }
        currentListIndexRef.current = currentIndex;
        const result = showMore ? currentGameComponentsRef.current.concat(newList) : newList;
        currentGameComponentsRef.current = result;
        return result;
    }, [filters, ownedGames]);

    // Set appropriate styles for Windows specifically
    useEffect(() => {
        if (gameComponents.length !== 0) {
            const isWindows = navigator.userAgentData.platform.toLowerCase().includes('windows');
            const gameList = document.getElementById('game-list');

            if (isWindows && gameList) {
                gameList.classList.add(styles['os-windows']);
            }
            const gameContainer = document.getElementById('update-container');
            if (isWindows && gameList) {
                gameContainer.classList.add(styles['os-windows']);
            }
        }
    }, [gameComponents.length]);

    useEffect(() => {
        if (loadingProgress != null) {
            setSelectedGame(null);
        }
        const newComponents = createGameComponents(filteredList ?? gameUpdates);
        setGameComponents(newComponents);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filters, filteredList]);

    useEffect(() => {
        if (gameComponents.length === 0) {
            const gameComponents = createGameComponents(gameUpdates);
            setGameComponents(gameComponents);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ownedGames]);

    const insertIntoExistingDataList = (newUpdates) => {
        const getUpdate = (appid, posttime) => {
            const { events, name } = ownedGames[appid];
            const updateIndex = events.findIndex(e => e.posttime === posttime);
            return { name, update: events[updateIndex], updateIndex };
        };

        const binarySearchInsertIndex = (arr, posttime) => {
            let low = 0, high = arr.length;
            while (low < high) {
                const mid = (low + high) >> 1;
                if (arr[mid].update.posttime <= posttime) {
                    high = mid;
                } else {
                    low = mid + 1;
                }
            }
            return low;
        };

        let currentIndex = currentListIndexRef.current;
        let newList = [...currentGameComponentsRef.current];

        for (const [posttime, appid] of newUpdates) {
            const { name, update, updateIndex } = getUpdate(appid, posttime);
            if (!update || filters.includes(update.event_type)) continue;

            const insertIndex = binarySearchInsertIndex(newList, posttime);
            newList.splice(insertIndex, 0,
                <GameUpdateListComponent
                    key={appid + '-' + update.posttime}
                    appid={appid}
                    name={name}
                    update={update}
                    newlyAdded={true}
                    setSelectedGame={setSelectedGame}
                    index={insertIndex}
                    eventIndex={updateIndex}
                />
            );
            currentIndex++;
        }

        newList = newList.map((component, idx) =>
            cloneElement(component, { index: idx })
        );

        currentListIndexRef.current = currentIndex;
        currentGameComponentsRef.current = newList;
        setGameComponents(newList);
    };

    useEffect(() => {
        if (loadingProgress === 100 &&
            currentGameComponentsRef.length &&
            gameUpdatesRef.current != null /* &&
            gameUpdates.length !== gameUpdatesRef.current.length */
        ) {
            const oldGameUpdates = [...gameUpdatesRef.current];
            const oldSet = new Set(oldGameUpdates.map(([ms, id]) => `${ms}:${id}`));
            const newlyAddedUpdates = gameUpdates.filter(([ms, id]) =>
                !oldSet.has(`${ms}:${id}`)
            );
            insertIntoExistingDataList(newlyAddedUpdates);
            gameUpdatesRef.current = null;
        } else if (loadingProgress !== 100) {
            gameUpdatesRef.current = gameUpdates
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loadingProgress]);

    // useEffect(() => {
    //     // handle the case where a user refreshes their updates.
    //     if (gameUpdates.length === 0) {
    //         setSelectedGame(null);
    //         setGameComponents([]);
    //     }
    // }, [gameUpdates]);

    useEffect(() => {
        const previousSelectedGame = document.getElementsByClassName(styles.selected)[0];
        if (previousSelectedGame) {
            previousSelectedGame.classList.remove(styles.selected);
            previousSelectedGame.classList.remove(styles['newly-added']);
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
            newIndex = selectedIndex < gameComponents.length - 1 ? selectedIndex + 1 : selectedIndex;
        }

        if (newIndex !== selectedIndex) {
            const newSelectedGame = gameComponents.find(item => item.props.index === newIndex);
            if (newSelectedGame) {
                const { props: { appid, eventIndex, index } } = newSelectedGame;
                const update = ownedGames[appid].events[eventIndex];
                setSelectedGame({ appid, update, index });
            }
        }
    }, [gameComponents, ownedGames, selectedGame?.index]);

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
    }, [handleKeyDown]);

    const handleScroll = () => {
        const gameList = document.getElementById('game-list');
        const isAtBottom = gameList.scrollTop + gameList.clientHeight >= gameList.scrollHeight - 200;
        if (isAtBottom) {
            const newComponents = createGameComponents(filteredList ?? gameUpdates, true);
            setGameComponents(newComponents);
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
    }, [gameComponents]);

    return (
        <div className={styles["app-body"]} >
            {Object.keys(gameUpdates).length === 0 || gameComponents.length === 0 ?
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
                            loadingProgress === 100 && ownedGames != null && filteredList == null ?
                                <>
                                    It seems like you don't own any Steam games...
                                    <br />
                                    <small>
                                        <b>**</b>
                                        {' Make sure that your '}
                                        <a href={`https://steamcommunity.com/profiles/${id}/edit/settings`} target='_blank' rel="noreferrer">"Game Details"</a>
                                        {' are set to "Public" '}
                                        <b>**</b>
                                    </small>
                                    <br />
                                    <small><b>**</b> If this isn't the case try logging out and then back in. <b>**</b></small>
                                </>
                                : loadingProgress === 100 && filteredList != null ?
                                    <>No search results - try something else...</>
                                    :
                                    <>Gathering updates for your owned games - hang tight...</>
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
                            {(gameComponents).concat(
                                <div
                                    key='filler-list-item'
                                    className={styles['empty-game']}
                                />
                            )}
                        </div>
                        <div id="update-container" className={styles['update-container']}>
                            <div className={styles["container-header"]}>
                                <div className={styles['update']}>Update</div>
                            </div>
                            <div
                                id='update-content'
                                data-gid={selectedGame?.update?.gid ?? ''}
                                className={styles['update-content']}
                                style={selectedGame === null ? { opacity: 1 } : {}}
                            >{selectedGame != null ?
                                <GameUpdateContentComponent
                                    appid={selectedGame.appid}
                                    update={selectedGame.update}
                                    name={ownedGames[selectedGame.appid].name}
                                />
                                :
                                <div>Click or use the keyboard to see a game's update details.</div>
                                }
                            </div>
                        </div>
                    </div>
                </>
            }
        </div >
    );
}
