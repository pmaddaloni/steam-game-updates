import parse from 'html-react-parser';
import { useEffect, useState } from 'react';
import { debounce, getViableImageURL } from '../../utilities/utils';

import styles from './body-styles.module.scss';

function parseTableAttributes(bsCode) {
    const closeTagMatch = bsCode.match(/^\[\/(.*?)]$/);
    if (closeTagMatch) {
        const tagName = closeTagMatch[1];
        return `</${tagName}>`;
    }
    const tagMatch = bsCode.match(/^\[(\w+)(?:\s|\])/);
    const tagName = tagMatch ? tagMatch[1].trim() : 'div';

    const styleAttributes = {};
    const attributeRegex = /(colwidth|rowwidth|colheight|rowheight)="([^"]*)"/g;
    let match;

    while ((match = attributeRegex.exec(bsCode)) !== null) {
        const attributeName = match[1];
        const attributeValue = match[2];

        if (attributeName.includes('width')) {
            styleAttributes.width = attributeValue;
        } else if (attributeName.includes('height')) {
            styleAttributes.height = attributeValue;
        }
    }

    let styleString = '';
    for (const key in styleAttributes) {
        if (Object.prototype.hasOwnProperty.call(styleAttributes, key)) {
            styleString += `${key}: ${styleAttributes[key]};`;
        }
    }

    return `<${tagName} style="${styleString} background-color:${tagName === 'th' ? '#18396aff' : '#3d5f8eff'}; border: 1px solid #808080; padding: 8px;">`;
};

function formatTextToHtml(text) {
    let html = '';
    const lines = text.split('\n');
    for (const line of lines) {
        let words = line.match(/\[.+?\]|\[\/.+\]|\S[^[]+/g);
        if (words != null) {
            let isImage = false;
            let isTable = false;
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
                    html = html.trimEnd();
                    html += '</u> ';
                } else if (word.startsWith('[p')) {
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
                } else if (word.startsWith('[h4')) {
                    html += '<h4>';
                } else if (word === '[/h4]') {
                    html += '</h4>';
                } else if (word.startsWith('[h5')) {
                    html += '<h5>';
                } else if (word === '[/h5]') {
                    html += '</h5>';
                } else if (word === '[quote]') {
                    html += '<blockquote>';
                } else if (word === '[/quote]') {
                    html += '</blockquote>';
                } else if (word.startsWith('[color=')) {
                    const startIndex = word.indexOf('=') + 1
                    const color = word.slice(startIndex, -1);
                    html += `<span style="color: ${color};">`
                } else if (word === '[/color]') {
                    html += '</span>';
                } else if (word.trim() === ':alertalert:') {
                    html += '<img src="https://community.fastly.steamstatic.com/economy/emoticon/alertalert" class="alert" alt="alertalert"></img>';
                } else if (word.startsWith('[url=')) {
                    const startIndex = word.indexOf('=') + 1
                    const url = word.slice(startIndex, -1);
                    html += `<a style="text-decoration: none;" href=${url} target="_blank" rel="noopener noreferrer">`;
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
                } else if (word.startsWith('[carousel') || word === '[/carousel]') {
                    continue;
                } else if (word.startsWith('[table')) {
                    isTable = true;
                    html += '<table style="border-collapse: collapse; border: 1px solid #808080;">';
                } else if (isTable) {
                    html += word.startsWith('[') ? parseTableAttributes(word) : word;
                } else if (word === '[/table]') {
                    isTable = true;
                    html += '</table>';
                } else {
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

const resetOpacity = debounce(() => {
    const element = document.getElementById('update-content');
    if (element) {
        setTimeout(() => {
            element.style.transition = 'opacity 300ms linear';
            element.style.opacity = 1
        }, 50);
    }
}, 400, true);

export default function GameUpdateContentComponent({ appid, name, update }) {
    const [imageURL, setImageURL] = useState(null);
    const [currentGID, setCurrentGID] = useState(update.gid);
    const patchNotesURL = `https://steamcommunity.com/games/${appid}/announcements/detail/${update.gid}`

    useEffect(() => {
        setCurrentGID(update.gid);
        resetOpacity();
    }, [update.gid]);

    useEffect(() => {
        const imageURLs = [
            `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
            `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/capsule_231x87.jpg`,
            'api'
        ];

        (async () => {
            const validImageURL = await getViableImageURL(imageURLs, 'header_image', appid, name)
            setImageURL(validImageURL);
        })();
    }, [appid, name]);

    return (
        currentGID !== update.gid ?
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
