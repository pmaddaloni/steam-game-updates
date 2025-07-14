import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../AuthContext';
import styles from './body-styles.module.scss';
import GameUpdateContentComponent from './GameUpdateContentComponent';
import GameUpdateListComponent from './GameUpdateListComponent';

import logo from './steam-logo.svg';

export default function Body() {
    const itemsPerPage = 25;
    const { id, gameUpdates, ownedGames, filteredList } = useAuth();
    const [currentIndex, setCurrentIndex] = useState(0);
    const [selectedGame, setSelectedGame] = useState(null);
    const [filteredComponents, setFilteredComponents] = useState(null);
    const [gameComponents, setGameComponents] = useState([]);
    const currentGameComponentsRef = useRef([]);
    const shownEventsRef = useRef({}); // {[appid]: # of times it's in the list}
    const timeoutId = useRef(null);

    const createGameComponents = useCallback((components, index = 0) => {
        const shownEvents = shownEventsRef.current;
        let componentIndex = currentGameComponentsRef.current.length;
        const gamesArray = components.slice(index, index + itemsPerPage);
        const result = currentGameComponentsRef.current.concat(gamesArray
            .reduce((acc, [, appid]) => {
                const { events, name } = ownedGames[appid] ?? {};
                if (events != null && events.length > 0) {
                    shownEvents[appid] = (shownEvents[appid] ?? -1) + 1
                    const update = events[shownEvents[appid]];
                    if (update != null) {
                        acc.push(
                            <GameUpdateListComponent
                                eventIndex={shownEvents[appid]}
                                key={appid + '-' + update?.posttime}
                                appid={appid}
                                name={name}
                                update={update}
                                setSelectedGame={setSelectedGame}
                                index={componentIndex++}
                            />
                        )
                    }
                }
                return acc;
            }, []));
        currentGameComponentsRef.current = result;
        return result;
    }, [ownedGames]);

    useEffect(() => {
        currentGameComponentsRef.current = [];
        setSelectedGame(null);
        setCurrentIndex(0);
        if (filteredList != null) {
            const filteredGameComponents = createGameComponents(filteredList);
            setFilteredComponents(filteredGameComponents);
        } else {
            setFilteredComponents(null);
        }
    }, [createGameComponents, filteredList]);

    useEffect(() => {
        currentGameComponentsRef.current = [];
        setSelectedGame(null);
        setCurrentIndex(0);
        const gameComponents = createGameComponents(gameUpdates);
        setGameComponents(gameComponents);
    }, [createGameComponents, gameUpdates]);

    useEffect(() => {
        if (currentIndex === 0) {
            return;
        }

        if (filteredComponents != null) {
            const filteredGameComponents = createGameComponents(filteredList);
            setFilteredComponents(filteredGameComponents, currentIndex);
        } else {
            const gameComponents = createGameComponents(gameUpdates, currentIndex);
            setGameComponents(gameComponents);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [createGameComponents, currentIndex]);

    useEffect(() => {
        // handle the case where a user refreshes their updates.
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

        const currentGameComponents = filteredComponents ?? gameComponents;
        const selectedIndex = selectedGame?.index ?? -1;
        let newIndex = selectedIndex;
        if (event.key === 'ArrowUp') {
            newIndex = selectedIndex > 0 ? selectedIndex - 1 : 0;
        } else if (event.key === 'ArrowDown') {
            newIndex = selectedIndex < currentGameComponents.length - 1 ? selectedIndex + 1 : selectedIndex;
        }

        if (newIndex !== selectedIndex) {
            const newSelectedGame = currentGameComponents.find(item => item.props.index === newIndex);
            if (newSelectedGame) {
                const { props: { appid, eventIndex, index } } = newSelectedGame;
                const update = ownedGames[appid].events[eventIndex];
                setSelectedGame({ appid, update, index });
            }
        }
    }, [filteredComponents, gameComponents, ownedGames, selectedGame?.index]);

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
        const currentGameComponents = filteredComponents ?? gameComponents;
        const gameList = document.getElementById('game-list');
        const isAtBottom = gameList.scrollTop + gameList.clientHeight >= gameList.scrollHeight - 200;
        if (isAtBottom) {
            const nextIndex = currentGameComponents.length - 1 + itemsPerPage;
            setCurrentIndex(nextIndex);
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
    }, [gameComponents, filteredComponents]);

    const gameComponentsToRender = filteredComponents ?? gameComponents;

    return (
        <div className={styles["app-body"]} >
            {Object.keys(gameUpdates).length === 0 || gameComponentsToRender.length === 0 ?
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
                            gameComponentsToRender.length === 0 ?
                                <>
                                    It seems like you don't own any Steam games...
                                    <br />
                                    <small><b>**</b>If this isn't the case try logging out and then back in.<b>**</b></small>
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
                            {(filteredComponents ?? gameComponents).concat(
                                <div
                                    key='filler-list-item'
                                    className={styles['empty-game']}
                                />
                            )}
                        </div>
                        <div className={styles['update-container']}>
                            <div className={styles["container-header"]}>
                                <div className={styles['update']}>Update</div>
                            </div>
                            <div
                                id='update-content'
                                data-gid={selectedGame?.update?.gid ?? ''}
                                className={styles['update-content']}
                                style={selectedGame === null ? { opacity: 1 } : {}}
                            >{
                                    selectedGame != null ?
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
