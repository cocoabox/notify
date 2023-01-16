"use strict";

const fs = require('fs');
const path = require('path');

async function get_voices() {
    const {execute} = this;
    const {stdout} = await execute('say', {args: ['-v', '?']});
    return stdout.map(stdout_line => {
        const mat = stdout_line.match(/^(.*?)\s+(.*?)[\-_](.*?)\s*#\s*(.*)$/);
        if (!mat) return null;
        const voice = mat[1];
        const country = mat[2].toLowerCase();
        const lang = mat[3].toLowerCase();
        const sample_text = mat[4].toLowerCase();
        return {voice, country, lang, sample_text};
    }).filter(n => !!n);
}

async function say(message, tags, lang, conf, {on_got_pid, on_query_killed}={}) {
    const {execute, sound_path_from_tags, cache_dir, sha1, escape_shell} = this;

    let use_voice;
    if (lang) {
    // determine voice to use
    const get_voices_res = await get_voices.apply(this, []);
    const voices = get_voices_res.filter(v => v.lang === lang || v.country === lang);
    const wanted_voice = conf?.default_voice?.[lang];
    // console.log('[say] voices =', JSON.stringify(voices), '; wanted_voice =', wanted_voice);
    use_voice = wanted_voice && 'undefined' !== typeof voices.find(v => v.voice === wanted_voice)
        ? wanted_voice
        : voices.find(v => v.lang === lang)?.voice;
    if (! use_voice) {
        console.warn(`[say] no voice available for lang=${lang}, message=${message}`);
        return;
    }
    }

    // console.log('[say] use_voice', use_voice);
    
    // common throw-if-killed function
    const throw_if_killed = () => {
        if (typeof on_query_killed === 'function' && on_query_killed() === true) {
            console.warn('say() aborted because kill');
            throw {killed: true};
        }
    };

    // main process
    try {
        const cache_filename = cache_dir ? (path.join(cache_dir, sha1({plugin: 'macos-say', message, tags, use_voice})) + '.aiff') : '';
        if (cache_filename) {
            if (! fs.existsSync(cache_filename)) {
                const say_res = await execute('say', {
                    args: [].concat(['-o', cache_filename], use_voice ? ['-v', use_voice] : [], [message]),
                    on_started: proc => { if (typeof on_got_pid === 'function') on_got_pid(proc.pid); },
                });
                if (say_res?.code !== 0) {
                    throw {error: 'say-error', say_res};
                }
            }
            if (typeof on_query_killed === 'function' && on_query_killed() === true) {
                console.warn('say() aborted because kill');
                throw {killed: true};
            }
            const sound_path = sound_path_from_tags(tags);
            if (sound_path) {
                await execute('afplay', {
                    args: ['--rQuality', '1', sound_path], 
                    on_started: proc => { if (typeof on_got_pid === 'function') on_got_pid(proc.pid); },
                });
            }
            throw_if_killed();

            const afplay_res = await execute('afplay', {
                args: ['--rQuality', '1', cache_filename], 
                on_started: proc => { if (typeof on_got_pid === 'function') on_got_pid(proc.pid); },
            });
            return {done: 1, afplay_res};
        } 
        else {
            // no cache
            const sound_path = sound_path_from_tags(tags);
            if (sound_path) {
                await execute('afplay', {
                    args: ['--rQuality', '1', sound_path], 
                    on_started: proc => { if (typeof on_got_pid === 'function') on_got_pid(proc.pid); },
                });
            }
            throw_if_killed();
            const say_res = await execute('say', {
                args: ['-v', use_voice, message],
                on_started: proc => { if (typeof on_got_pid === 'function') on_got_pid(proc.pid); },
            });
            if (say_res?.code !== 0) {
                throw {error: 'say-error', say_res};
            }
            return {done: 1, say_res};
        }
    }
    catch (reason) {
        if (reason?.killed || typeof on_query_killed === 'function' && on_query_killed() === true) {
            console.warn('say killed ; reason :', reason);
            throw {killed: true, reason};
        }
        else {
            console.warn('say failed ; reason :', reason);
            throw {reason};
        }
    }

   
}

async function is_say_available(message, lang, conf) {
    if (process.platform !== 'darwin') {
        //console.warn('[say] not darwin, say is NOT available');
        return false;
    }
    const voices = await get_voices.apply(this);
    const avail_voices = voices.filter(v => v.lang === lang || v.country === lang);
    // console.log('available voices:', JSON.stringify(avail_voices));
    const avail = avail_voices.length > 0;
    // console.warn('[say] is macOS and say is', avail? 'available': 'NOT available');
    return avail;
}

module.exports = {
    speak_plugin_name: 'say',
    main: say,
    is_available: is_say_available,
};
