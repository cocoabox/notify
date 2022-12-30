"use strict";

const fs = require('fs');
const oauthRevenge = require('oauth-revenge');

function tweet(message, tags, config) {
    console.warn('[tweet] message=',message,'; tags=',tags);
    const {app, oauth, mention, emit_tags} = config;
    const {consumer_key, consumer_secret} = app;
    const {oauth_token, oauth_token_secret} = oauth;
    const account_token = { token: oauth_token, tokenSecret: oauth_token_secret };

    return new Promise((resolve, reject) => {
        if (!app || !oauth) {
            console.warn('[tweet] app and oauth not properly configured');
            reject({error:'bad-config'});
        }
        const consumer = {
            key: consumer_key,
            secret: consumer_secret,
        };
        const signer = oauthRevenge.createHmac(consumer, account_token);
        const client = oauthRevenge.createClient(signer);
        const tags_str = emit_tags 
            ? tags.map(t => `#${t}`).map(h => h.match( /(^|\B)#(?![0-9_]+\b)([a-zA-Z0-9_]{1,30})(\b|\r)/g )?.[0]).filter(n => !!n).join(' ')
            : '';
        const emoji = tags.includes('critical') ? '🔥' : tags.includes('warn') ? '⚠️': '';
        const mention_str = mention ? `@${mention}`: '';
        const status = `${mention_str} ${emoji} ${message} ${tags_str}`.trim();
        client.POST('https://api.twitter.com/1.1/statuses/update.json', { status }, res => {
            res.setEncoding('utf8');
            res.on('data', function (response) {
                console.warn('[twitter] done');
                resolve({done: 1, response});
            });
            res.on('error', function(err) {
                console.warn('[twitter] error', err); 
                reject({error: 1, details: err});
            });
        });

    });
}

module.exports = {
    plugin_name: 'twitter',
    enabled_by_default: false,
    main: tweet,
};
