import { useEffect, useState } from 'react';
import { getViableImageURL } from '../../utilities/utils';
import styles from './body-styles.module.scss';

export default function GameUpdateListComponent(props) {
    const { appid, name, update, setSelectedGame, index } = props;
    const [imageURL, setImageURL] = useState(null);
    const changeSelectedGame = () => {
        const element = document.getElementById('update-content');
        if (element && element.dataset.gid !== update.gid) {
            element.style.transition = null;
            element.style.opacity = 0;
            setSelectedGame({ appid, update, index });
        }
    };

    useEffect(() => {
        const imageURLs = [
            `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/capsule_231x87.jpg`,
            `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
            'api'
        ];

        (async () => {
            const validImageURL = await getViableImageURL(imageURLs, 'capsule_image', appid, name)
            setImageURL(validImageURL);
        })();
    }, [appid, name]);

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
                <div id={`${appid}`} className={styles['game-title']}>
                    {imageURL != null ?
                        <img className={styles['game-capsule']} src={imageURL} alt="logo" /> :
                        <div className={styles['game-capsule']}>{name}</div>
                    }
                </div>
                <div className={styles['patch-title']}>{update.headline}</div>
            </div>
        </>
    )
}
