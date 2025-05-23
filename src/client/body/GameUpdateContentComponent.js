import parse from 'html-react-parser';
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
                } else if (word.startsWith('[url=')) {
                    const url = 'https://' + word.slice(5, -1);
                    html += '<a href="' + url + '" target="_blank" rel="noopener noreferrer">';
                } else if (word === '[/url]') {
                    html += '</a>';
                } else if (word.startsWith('[previewyoutube=')) {
                    const youtubeVideoID = word.slice(16, -1);
                    const url = 'https://www.youtube.com/embed/' + youtubeVideoID;
                    html += '<div style="text-align-last:center"><iframe width="600" height="338" src="'
                        + url + '" frameborder="0" allowfullscreen></iframe>';
                } else if (word.startsWith('[/previewyoutube]')) {
                    html += '</div>';
                } else if (word === '[img]') {
                    isImage = true;
                    html += '<img src=';
                } else if (isImage) {
                    const url = word.replace('{STEAM_CLAN_IMAGE}',
                        'https://clan.cloudflare.steamstatic.com/images/');
                    html += '"' + url + '"';
                    isImage = false;
                } else if (word === '[/img]') {
                    html += ' alt="image" />';
                } else if (word.includes('https://')) {
                    const urlRegex = /(https?:\/\/[^\s]+)/g
                    const urlMatch = word.match(urlRegex)[0];
                    const url = `<a href=${urlMatch} target="_blank" rel="noopener noreferrer">${urlMatch}</a>`
                    html += word.replace(urlRegex, url);
                } else if (word.startsWith('[expand')) {
                    html += '<details><div>';
                } else if (word === '[/expand]') {
                    html += '</div></details>';
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

export default function GameUpdateContentComponent({ appid, update }) {
    const patchNotesURL = `https://steamcommunity.com/games/${appid}/announcements/detail/${update.gid}`
    return (
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
                <img className={styles['game-capsule']} src={`https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/capsule_231x87.jpg`} alt="logo" />
            </div>
            <div className={styles['update-divider']} />
            <div className={styles['update-body']}>{parse(formatTextToHtml(update?.body))}</div>
        </ >
    )
};
