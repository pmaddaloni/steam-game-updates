import parse from 'html-react-parser';
import { useEffect, useState } from 'react';
import { getViableImageURL } from '../../utilities/utils';

import styles from './body-styles.module.scss';

function formatTextToHtml(text) {
    let html = '';
    const lines = text.split('\n');
    for (const line of lines) {
        let words = line.match(/\[.+?\]|\[\/.+\]|\S[^[]+/g);
        if (words != null) {
            let isImage = false;
            for (const word of words) {
                if (word === '[b]') {
                    html += '<strong>';
                } else if (word === '[/b]') {
                    html += '</strong>';
                } else if (word === '[i]') {
                    html += '<em>';
                } else if (word === '[/i]') {
                    html += '</em>';
                } else if (word === '[u]') {
                    html += '<u>';
                } else if (word === '[/u]') {
                    html += '</u>';
                } else if (word === '[p]') {
                    html += '<p>';
                } else if (word === '[/p]') {
                    html += '</p>';
                } else if (word === '[br]') {
                    html += '<br />';
                } else if (word === '[hr]') {
                    html += '<hr />';
                } else if (word === '[/hr]') {
                    // Do nothing
                } else if (word === '[list]') {
                    html += '<ul>';
                } else if (word === '[/list]') {
                    html += '</ul>';
                } else if (word === '[olist]') {
                    html += '<ol>';
                } else if (word === '[/olist]') {
                    html += '</ol>';
                } else if (word === '[*]') {
                    html += '<li>';
                } else if (word === '[/*]') {
                    html += '</li>';
                } else if (word.startsWith('[h1')) {
                    html += '<h1>';
                } else if (word === '[/h1]') {
                    html += '</h1>';
                } else if (word.startsWith('[h2')) {
                    html += '<h2>';
                } else if (word === '[/h2]') {
                    html += '</h2>';
                } else if (word.startsWith('[h3')) {
                    html += '<h3>';
                } else if (word === '[/h3]') {
                    html += '</h3>';
                } else if (word === '[quote]') {
                    html += '<blockquote>';
                } else if (word === '[/quote]') {
                    html += '</blockquote>';
                } else if (word.trim() === ':alertalert:') {
                    html += '<img src="https://community.fastly.steamstatic.com/economy/emoticon/alertalert" class="alert" alt="alertalert"></img>';
                } else if (word.startsWith('[url=')) {
                    const startIndex = word.indexOf('=') + 1
                    const url = word.slice(startIndex, -1);
                    html += `<a href=${url} target="_blank" rel="noopener noreferrer">`;
                } else if (word === '[/url]') {
                    html += '</a>';
                } else if (word.startsWith('[dynamiclink href=')) {
                    const startIndex = word.indexOf('=') + 1
                    const url = word.slice(startIndex, -1);
                    const gameName = url.replaceAll('"', '').split('/')?.filter(Boolean)?.pop()?.replaceAll('_', ' ');
                    html += `<p><a href=${url} target="_blank" rel="noopener noreferrer">${gameName}`;
                } else if (word === '[/dynamiclink]') {
                    html += '</a></p>';
                } else if (word.startsWith('[previewyoutube=')) {
                    const youtubeVideoID = word.slice(16, -1).replace('"', '');
                    console.log(youtubeVideoID)
                    const url = 'https://www.youtube.com/embed/' + youtubeVideoID;
                    html += '<div style="text-align-last:center"><iframe width="600" height="338" src='
                        + url + ' frameborder="0" allowfullscreen></iframe>';
                } else if (word.startsWith('[/previewyoutube]')) {
                    html += '</div>';
                } else if (word === '[img]') {
                    isImage = true;
                    html += '<p><img src=';
                } else if (isImage) {
                    const url = word.replace('{STEAM_CLAN_IMAGE}',
                        'https://clan.cloudflare.steamstatic.com/images/');
                    html += '"' + url + '"';
                    isImage = false;
                } else if (word === '[/img]') {
                    html += ' alt="image" /></p>';
                } else if (word.startsWith('[img ')) {
                    let url = word.match(/"(.*?)"/)?.[1] ?? '';
                    url = url.replace('{STEAM_CLAN_IMAGE}',
                        'https://clan.cloudflare.steamstatic.com/images/')
                    html += `<img src=${url}`;
                } else if (word.includes('https://')) {
                    const urlRegex = /(https?:\/\/[^\s]+)/g
                    const urlMatch = word.match(urlRegex)[0];
                    const url = `<a href=${urlMatch} target="_blank" rel="noopener noreferrer">${urlMatch}</a>`
                    html += word.replace(urlRegex, url);
                } else if (word.startsWith('[expand')) {
                    html += '<details><div>';
                } else if (word === '[/expand]') {
                    html += '</div></details>';
                } else if (word.startsWith('[spoiler')) {
                    html += '<details><summary>Spoilers!</summary><div>';
                } else if (word === '[/spoiler]') {
                    html += '</div></details>';
                }
                else {
                    html += (word ?? '') + ' ';
                }
            }
        }
        if ((/\[\w+\]|\[\/\w+\]/g).test(line) === false) {
            html += '<br />';
        }
    }
    return html;
};

export default function GameUpdateContentComponent({ appid, name, update }) {
    const [imageURL, setImageURL] = useState(null);
    const [currentAppId, setCurrentAppId] = useState(null);
    const patchNotesURL = `https://steamcommunity.com/games/${appid}/announcements/detail/${update.gid}`

    useEffect(() => {
        setCurrentAppId(appid);
        setImageURL(null);
    }, [appid]);

    useEffect(() => {
        const imageURLs = [
            `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${currentAppId}/header.jpg`,
            `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${currentAppId}/capsule_231x87.jpg`,
            'api'
        ];

        (async () => {
            const validImageURL = await getViableImageURL(imageURLs, 'header_image', currentAppId, name)
            setImageURL(validImageURL);
        })();
    }, [currentAppId, name]);

    return (
        currentAppId !== appid ?
            null :
            <>
                <div className={styles['update-header']}>
                    <div className={styles['update-title']}>
                        <div className={styles['update-headline']}>
                            <a href={patchNotesURL} target="_blank" rel="noreferrer" >{update?.headline}</a>
                        </div>
                        <div className={styles['update-post-time']} >
                            <span>Posted on </span>
                            <span>{new Date(update.posttime * 1000).toLocaleDateString()}</span>
                            <span> at </span>
                            <span>{new Date(update.posttime * 1000).toLocaleTimeString()}</span>
                        </div>
                    </div>
                    {imageURL != null ?
                        <img className={styles['game-capsule']} src={imageURL} alt="logo" /> :
                        <div className={styles['game-capsule']}>{name}</div>
                    }</div>
                <div className={styles['update-divider']} />
                <div className={styles['update-body']}>{parse(formatTextToHtml(update?.body))}</div>
            </>
    )
};
