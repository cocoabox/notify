"use strict";

const axios = require('axios');
const querystring = require('querystring');

async function line_notify(message, tags, config) {
    const {token, emit_tags} = config;
    if (! token) {
        console.warn('no token configured; to create one, see : https://notify-bot.line.me/my/');
        throw {error: 'bad-config'};
    }
    const emoji = tags.includes('critical') ? '🔥' : tags.includes('warn') ? '⚠️': '';
    const tags_str = emit_tags ? tags.map(t => `#${t}`).join(' ') : '';
    const full_message = `${emoji} ${message} ${tags_str}`.trim();
    console.log(`[LINE] notify : ${message}`, tags);
    try {
        const axios_res = await axios({
            method: 'post',
            url: 'https://notify-api.line.me/api/notify',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            data: querystring.stringify({ message: full_message }),
        });
        console.warn('[LINE] successful', axios_res.data);
        return {done: 1, result: axios_res.data};
    }
    catch (reason) {
        console.warn('[LINE] error', reason);
        throw {error: reason};
    }

}

module.exports = {
    plugin_name: 'line',
    enabled_by_default: true,
    main: line_notify,
};
