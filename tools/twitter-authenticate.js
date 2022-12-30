#!/usr/bin/env node

"use strict"; 

const fs = require('fs');
const path = require('path');
const JSON5 = require('JSON5');
const https = require('https');
const querystring = require('querystring');
const crypto = require('crypto');
const {EventEmitter} = require('events');
const readline = require('readline');

// shamelessly ripped from :
// https://gist.github.com/netalkGB/caabe9299e0752e0e7b15d4d783dcbba

class TwitterPinAuth extends EventEmitter {
    constructor(ckcs) {
        super();
        this.consumer_key = ckcs.consumer_key;
        this.consumer_secret = ckcs.consumer_secret;
        let signature_key = encodeURIComponent(this.consumer_secret) + "&";

        let http_method = "POST";
        let request_url = "https://api.twitter.com/oauth/request_token";
        let query = {
            "oauth_version": '1.0',
            "oauth_timestamp": Math.floor(new Date().getTime() / 1000),
            "oauth_callback": "oob",
            "oauth_consumer_key": this.consumer_key,
            "oauth_signature_method": 'HMAC-SHA1',
            "oauth_nonce": Math.random().toString(36).slice(-8),
        };
        let query_parameter = querystring.stringify(this.ksort(query));
        let signature_base_string = encodeURIComponent(http_method) + "&" + encodeURIComponent(request_url) + "&" + encodeURIComponent(query_parameter);
        let hmac = crypto.createHmac('sha1', signature_key);
        hmac.update(signature_base_string);
        let oauth_signature = encodeURIComponent(hmac.digest('base64'));
        let options = {
            hostname: 'api.twitter.com',
            port: 443,
            path: '/oauth/request_token',
            method: 'POST',
            headers: {
                "Authorization": `OAuth oauth_nonce="${query.oauth_nonce}",oauth_callback="${query.oauth_callback}",oauth_signature_method="${query.oauth_signature_method}",oauth_timestamp="${query.oauth_timestamp}",oauth_consumer_key="${query.oauth_consumer_key}",oauth_signature="${oauth_signature}",oauth_version="${query.oauth_version}"`,
                'content-type': 'application/json'
            },
        };
        let req = https.request(options, (res) => {
            let str = "";
            res.on('data', (chunk) => {
                str += chunk;
            });

            res.on('end', () => {
                let url = `https://api.twitter.com/oauth/authorize?oauth_token=${querystring.parse(str).oauth_token}`;
                this.oauth_token = querystring.parse(str).oauth_token;
                this.oauth_token_secret = querystring.parse(str).oauth_token_secret;
                this.emit('authorize_url', url);
            });

        });
        req.end();
        req.on('error', (e) => {
            this.emit('error', e);
            console.error(e);
        });
    }
    getOAuthAccessToken(pin) {
        let signature_key = encodeURIComponent(this.consumer_secret) + "&" + encodeURIComponent(this.oauth_token_secret);
        let http_method = "POST";
        let request_url = "https://api.twitter.com/oauth/access_token";
        let query = {
            "oauth_version": '1.0',
            "oauth_timestamp": Math.floor(new Date().getTime() / 1000),
            "oauth_token": this.oauth_token,
            "oauth_consumer_key": this.consumer_key,
            "oauth_verifier": pin,
            "oauth_signature_method": 'HMAC-SHA1',
            "oauth_nonce": Math.random().toString(36).slice(-8),
        };
        let query_parameter = querystring.stringify(this.ksort(query));
        let signature_base_string = encodeURIComponent(http_method) + "&" + encodeURIComponent(request_url) + "&" + encodeURIComponent(query_parameter);
        let hmac = crypto.createHmac('sha1', signature_key);
        hmac.update(signature_base_string);
        let oauth_signature = encodeURIComponent(hmac.digest('base64'));
        let options = {
            hostname: 'api.twitter.com',
            port: 443,
            path: '/oauth/access_token',
            method: 'POST',
            headers: {
                "Authorization": `OAuth oauth_consumer_key="${this.consumer_key}",oauth_nonce="${query.oauth_nonce}",oauth_signature_method="${query.oauth_signature_method}",oauth_timestamp="${query.oauth_timestamp}",oauth_token="${query.oauth_token}",oauth_verifier="${query.oauth_verifier}",oauth_version="${query.oauth_version}",oauth_signature="${oauth_signature}"`,
                'content-type': 'application/json',
            },
        };
        let req2 = https.request(options, (res) => {
            let str2 = "";
            res.on('data', (chunk) => {
                str2 += chunk;
            });

            res.on('end', ()=> {
                let tokens = { oauth_token: querystring.parse(str2).oauth_token, oauth_token_secret: querystring.parse(str2).oauth_token_secret };
                this.emit('done', tokens);
            });

        });
        req2.end();
        req2.on('error', (e) => {
            this.emit('error', e);
            console.error(e);
        })

    }
    ksort(obj) {
        let obj2 = {};
        let keys = Object.keys(obj).sort();
        for (let i = 0; i < keys.length; i++) {
            obj2[keys[i]] = obj[keys[i]];
        }
        return obj2;
    }
}

const app_config_json_path = path.join(__dirname, '..', 'conf', 'twitter-app.json5');

const app_config = JSON5.parse(fs.readFileSync(app_config_json_path, 'utf8'));
if (! app_config.consumer_key || ! app_config.consumer_secret) {
    console.warn(`Please configure "${app_config_json_path}" with the following : { consumer_key: ... , consumer_secret : ... }`);
    process.exit(1);
}

let pinauth = new TwitterPinAuth(app_config);
pinauth.on('error', (e) => {
    console.warn('PIN Auth error :', e);
    process.exit(1);
})
pinauth.on('authorize_url', (url) => {
    console.log(`Please open page : ${url} and enter PIN`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (pin) => {
        pin = pin.trim();
        pinauth.getOAuthAccessToken(pin);
    })
})
pinauth.on('done', (tokens) => {
    const twitter_oauth_conf = {oauth_token: tokens.oauth_token, oauth_token_secret: tokens.oauth_token_secret};
    const oauth_config_json_path = path.join(__dirname, '..', 'conf', 'twitter-oauth.json5');
    const json_body = JSON.stringify(twitter_oauth_conf, '', 4);
    fs.writeFileSync(oauth_config_json_path, json_body, 'utf8');
    console.warn(`Done writing to "${oauth_config_json_path} :`, twitter_oauth_conf);
    process.exit(0);
});

