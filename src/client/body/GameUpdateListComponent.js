import styles from './body-styles.module.scss';

export default function GameUpdateListComponent(props) {
    const { appid, update, setSelectedGame, index } = props;
    const changeSelectedGame = () => {
        setSelectedGame({ appid, update, index });
    };

    return (
        <>
            <div
                id={index}
                key={`${appid}-${index}`}
                onClick={changeSelectedGame}
                className={styles.game}
            >
                <div className={styles['patch-date']}>
                    <div>{new Date(update.posttime * 1000).toLocaleDateString()}</div>
                    <div>{new Date(update.posttime * 1000).toLocaleTimeString()}</div>
                </div>
                <div className={styles['game-title']}>
                    <img id='game-capsule' src={`https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/capsule_231x87.jpg`} alt="logo" />
                </div>
                <div className={styles['patch-title']}>{update.headline}</div>
            </div>
        </>
    )
}
