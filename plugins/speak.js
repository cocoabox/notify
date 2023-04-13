"use strict";

const execute = require('../execute');
const LanguageDetection = require('@smodin/fast-text-language-detection');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

let speak_plugins = null;

const sounds = {
    'critical':'CHORD.WAV',
    'warn':'DING.WAV',
    'info':'pong.wav',
    'uh-oh':'ICQMessage.wav',
    'time': 'cuckoo.wav',
};

function load_plugins() {
    if (speak_plugins) { return speak_plugins; }

    const plugin_dir = path.join(__dirname, 'speak-plugins');
    const is_file = filepath => (fs.statSync(filepath)).isFile();
    const requires = fs.readdirSync(plugin_dir).filter(fs => fs.match(/\.js$/)).map(fn => `./speak-plugins/${fn}`);
    // console.log('speak plugins :',requires);
    const plugin_entries = requires.map(r => {
        try {
            const {speak_plugin_name, main, is_available} = require(r);
            const is_speak_plugin = speak_plugin_name && typeof main === 'function' && typeof is_available === 'function';
            return is_speak_plugin ? {speak_plugin_name, main, is_available} : null;
        }
        catch (error) {
            console.warn('failed to load speak plugin :', r, error);
            return null;
        }
    }).filter(p => !!p);
    speak_plugins = plugin_entries;
    return speak_plugins;
}

function sha1(of_what) {
    const shasum = crypto.createHash('sha1');
    shasum.update(JSON.stringify(of_what));
    return shasum.digest('hex');
}

function sound_path_from_tags_with_config(tags, config) {
    const default_sounds = Object.entries(sounds).map(([tag, filename])=>[
        tag, path.join(__dirname, 'sounds', filename)
    ]);
    const extra_sounds = Object.entries(config.extra_sounds ?? {}).map(([tag, filename])=>[
        tag, path.join(__dirname, 'extra-sounds', filename)
    ]);
    const all_sounds = Object.fromEntries([].concat(default_sounds, extra_sounds));
    for (const [tag, fullpath] of Object.entries(all_sounds)) {
        if (tags.includes(tag)) {
            return fullpath;
        }
    }
    return '';
}

function escape_shell (cmd) {
    // https://stackoverflow.com/questions/1779858/how-do-i-escape-a-string-for-a-shell-command-in-node
    return '"'+cmd.replace(/(["'$`\\])/g,'\\$1')+'"';
}

async function detect_language(message, preferred_languages=[]) {
    const lid = new LanguageDetection();
    let lang;
    try {
        const langs = (await lid.predict(message, 5)).filter(p => !! p.isReliableLanguage);
        // console.log(message, langs);
        lang = langs[0].lang;
        if (! preferred_languages.includes(lang) ) {
            // console.warn('first langauge is not preferred :', preferred_languages);
            for (const pl of preferred_languages) {
                // console.warn(`looking for ${pl} in langs=`, langs.map(l => l.lang));
                if (langs.find(l => l.lang === pl)) {
                    // console.warn('got preferred language in candidate list:', preferred_languages);
                    lang = pl;
                    break;
                }
            }
        }
        if (! langs?.length || ! lang) {
            console.warn('failed to detect lang :', message);
            lang = 'ja';
        }
    }
    catch (error) {
        console.warn('failed to detect lang :', message, '; error :', error);
        lang = 'ja';
    }
    return lang;
}

async function async_filter(arr, callback) {
    // https://stackoverflow.com/questions/33355528/filtering-an-array-with-a-function-that-returns-a-promise
    const fail = Symbol();
    return (await Promise.all(arr.map(async item => (await callback(item)) ? item : fail))).filter(i=>i!==fail);
}

async function speak(message, tags, config, {on_got_pid, on_query_killed, set_doing_lengthy_stuff}={}) {
    let detect_lang_preference = config.detect_lang ?? true;
    if (detect_lang_preference === 'macos-only') {
        detect_lang_preference = process.platform === 'darwin';
    }
    const lang = detect_lang_preference
        ? await detect_language(message, config?.preferred_languages)
        : '';
    // console.warn(`language of "${message}" is :`, lang);
    const plugins = load_plugins();
    const available_plugins = await async_filter(plugins, async p => {
        const {speak_plugin_name, is_available} = p;
        // console.log(`querying plugin availablility (${speak_plugin_name}) for message : ${message}`);
        const plugin_conf = config?.plugins?.[speak_plugin_name];
        if (plugin_conf?._disabled) {
            return false;
        }
        const ctx = {execute};
        return await is_available.apply(ctx, [message, lang, plugin_conf]);
    });
    // console.log('... speak-plugins available :', available_plugins.map( ap => ap.speak_plugin_name ));
    if (available_plugins.length === 0) {
        console.warn(`no plugins available for message : ${message}`);
        return;
    }
    const plugin = available_plugins[0];
    const {speak_plugin_name, main} = plugin;
    const plugin_config = config?.plugins?.[speak_plugin_name] ?? {};
    const context = {
        cache_dir: config?.cache_dir ?? '',
        execute,
        sound_path_from_tags: (tags)=> sound_path_from_tags_with_config(tags, config) ,
        sha1,
        on_got_pid,
        on_query_killed,
        escape_shell,
        set_doing_lengthy_stuff,
    };
    try {
        const speak_plugin_res = await main.apply(context, [
            message, tags, lang, plugin_config, context,
        ]);
        return {done: 1, speak_plugin_res};
    }
    catch (reason) {
        if (reason?.killed) {
            console.warn("🛑 speak plugin interrupted or killed");
            throw {killed: true};
        }
        else {
            console.warn('speak plugin failed with error :', reason);
            throw {error: reason};
        }
    }

}

module.exports = {
    plugin_name: 'speak',
    enabled_by_default: true,
    main: speak,
};
