import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../AuthContext';
import styles from './body-styles.module.scss';
import GameUpdateContentComponent from './GameUpdateContentComponent';
import GameUpdateListComponent from './GameUpdateListComponent';

import logo from './steam-logo.svg';

/* let timer = null;
function throttle(func, delay = 5000) {
    let timerFlag = null;
    return (...args) => {
        if (timerFlag === null) {
            func(...args);
            timerFlag = setTimeout(() => {
                timerFlag = null;
            }, delay);
        }
    };
} */


export default function Body() {
    const itemsPerPage = 25;
    const { id, gameUpdates, ownedGames, /* fetchMoreUpdates */ } = useAuth();
    const [displayedItems, setDisplayedItems] = useState([]);
    const [startIndex, setStartIndex] = useState(0);
    const [selectedGame, setSelectedGame] = useState(null);
    // const [prevLength, setPrevLength] = useState(0);
    // const [isLoading, setIsLoading] = useState(false);
    // const fechMoreUpdatesThrottled = useMemo(() => throttle(fetchMoreUpdates), [fetchMoreUpdates]);
    const gameComponents = useMemo(() => {
        const shownEvents = {};     // {[appid]: # of times it's in the list}
        return gameUpdates.map(([, appid], index) => {
            const { events } = ownedGames[appid] ?? {};
            if (events != null && events.length > 0) {
                shownEvents[appid] = (shownEvents[appid] ?? -1) + 1
                const update = events[shownEvents[appid]];
                return update && (
                    <GameUpdateListComponent
                        key={appid + '-' + update?.posttime}
                        appid={appid}
                        update={update}
                        setSelectedGame={setSelectedGame}
                        selectedGame={selectedGame}
                        index={index}
                        eventIndex={shownEvents[appid]}
                    />
                );
            }
            return null;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gameUpdates]);

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
    }, [selectedGame, displayedItems]);

    // useEffect(() => {
    //     if (gameUpdates.length !== prevLength) {
    // setIsLoading(false);
    // setPrevLength(gameUpdates.length)
    // }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // }, [gameUpdates])

    function showCursor() {
        document.body.style.pointerEvents = 'all';
    }

    let timeoutId = null;
    function handleKeyDown(event) {
        document.body.style.pointerEvents = 'none';

        clearTimeout(timeoutId);
        timeoutId = setTimeout(showCursor, 5000);

        const selectedIndex = selectedGame?.index ?? -1;
        let newIndex = selectedIndex;

        if (event.key === 'ArrowUp') {
            newIndex = selectedIndex > 0 ? selectedIndex - 1 : 0;
        } else if (event.key === 'ArrowDown') {
            newIndex = selectedIndex < displayedItems.length - 1 ? selectedIndex + 1 : selectedIndex;
        }

        if (newIndex !== selectedIndex) {
            const newSelectedGame = displayedItems.find(item => item.props.index === newIndex);
            const { props: { appid, eventIndex, index } } = newSelectedGame;
            const update = ownedGames[appid].events[eventIndex];
            setSelectedGame({ appid, update, index });
        }
    };

    useEffect(() => {
        let timeoutId = null;

        document.addEventListener('mousemove', () => {
            showCursor();
            clearTimeout(timeoutId);
        })
        window.addEventListener('keydown', handleKeyDown);

        return () => {
            document.removeEventListener('mousemove', showCursor);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [displayedItems, ownedGames, selectedGame]);

    const handleScroll = () => {
        const gameList = document.getElementById('game-list');
        const isAtBottom = gameList.scrollTop + gameList.clientHeight >= gameList.scrollHeight - 200;
        if (isAtBottom /* && !isLoading */) {
            const nextIndex = startIndex + itemsPerPage;
            const nextItems = [...gameComponents.slice(startIndex, nextIndex)];
            setStartIndex(nextIndex);
            setDisplayedItems([...displayedItems, ...nextItems]);
            // setIsLoading(true);
            // fechMoreUpdatesThrottled()
        }
    };

    // const callback = useCallback((entries) => {
    //     const entry = entries[0];
    //     const isIntersecting = entry?.isIntersecting
    //     if (isIntersecting) {
    //         const nextIndex = startIndex + itemsPerPage;
    //         const nextItems = [...gameComponents.slice(startIndex, nextIndex)];
    //         setStartIndex(nextIndex);
    //         setDisplayedItems([...displayedItems, ...nextItems]);
    //     }
    // }, [displayedItems, gameComponents, startIndex]);

    useEffect(() => {
        // const options = {
        //     root: document.querySelector("#game-list"),
        //     rootMargin: "0px",
        //     threshold: 1,
        // };

        // const observer = new IntersectionObserver(callback, options);
        const gameList = document.getElementById('game-list');
        // const gameList = document.getElementsByClassName(styles.game);
        if (gameList == null) {
            return;
        }

        // [...gameList].forEach(game => {
        //     if (game.dataset.index == displayedItems.length - 4) {
        //         observer.observe(game);
        //     }
        // })
        gameList.addEventListener('scroll', handleScroll);
        return () => {
            gameList.removeEventListener('scroll', handleScroll);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [displayedItems, /* isLoading */]);

    return (
        <div className={styles["app-body"]} >
            {Object.keys(gameUpdates).length === 0 ?
                <div className={styles['loading-container']}>
                    <img src={logo} className="App-logo" alt="logo" />
                    <p>
                        {id === '' ?
                            <>Log in to see updates for your games</>
                            :
                            <>Fetching your owned games</>
                        }
                    </p>
                </div> :
                <>
                    <div className={styles.container}>
                        <div id="game-list" className={styles['game-list']}>
                            <div className={styles['game-list-header']}>
                                <div className={styles['patch-date']}>Date</div>
                                <div className={styles['game-title']}>Game</div>
                                <div className={styles['patch-title']}>Title</div>
                            </div>
                            {displayedItems}
                        </div>
                        <div className={styles['update-container']}>
                            <div className={styles["container-header"]}>
                                <div className={styles['update']}>Update</div>
                            </div>
                            <div className={styles['update-content']}>{
                                selectedGame != null ?
                                    <GameUpdateContentComponent
                                        appid={selectedGame.appid}
                                        update={selectedGame.update}
                                    />
                                    :
                                    'Click a game to see its update details!'
                            }
                            </div>
                        </div>
                    </div>
                </>
            }
        </div >
    );
}
