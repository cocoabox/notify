"use strict";

const fs = require('fs');
const path = require('path');

async function aquestalkpi(message, tags, lang, conf, {on_got_pid, on_query_killed}={}) {
    const {execute, sound_path_from_tags, cache_dir, sha1, escape_shell} = this;
    const {app_path} = conf;

    //if (lang !== 'ja') {
    //    console.warn(`aquestalkpi: expecting japanese text but got : ${lang}`);
    //    throw {error: 'wrong-language'};
    //}

    const throw_if_killed = () => {
        if (typeof on_query_killed === 'function' && on_query_killed() === true) {
            console.warn('linux_AquesTalkPi() aborted because kill');
            throw {killed: true};
        }
    }
    try {
        const cache_filename = cache_dir ? path.join(cache_dir, sha1({plugin: 'AquesTalkPi', message, tags}) + '.wav') : '';
        const text_escaped = escape_shell(message);
        if (cache_filename) {
            if (! fs.existsSync(cache_filename)) {
                const aquestalkpi_res = await execute('/bin/bash', {
                    args: ['-c', `"${app_path}" ${text_escaped} > "${cache_filename}"`],
                    on_started: proc => { if (typeof on_got_pid === 'function') on_got_pid(proc.pid); },
                });
                if (aquestalkpi_res?.code !== 0) {
                    throw {error: 'aquestalkpi-error', aquestalkpi_res};
                }
            }
            throw_if_killed();
            const sound_path = sound_path_from_tags(tags);
            if (sound_path) {
                await execute('aplay', {
                    args: [sound_path], 
                    on_started: proc => { if (typeof on_got_pid === 'function') on_got_pid(proc.pid); },
                });
            }
            throw_if_killed();
            const aplay_res = await execute('aplay', {
                args: [cache_filename], 
                on_started: proc => { if (typeof on_got_pid === 'function') on_got_pid(proc.pid); },
            });
            return {done: 1, aplay_res};
        } 
        else {
            const sound_path = sound_path_from_tags(tags);
            if (sound_path) {
                await execute('aplay', {
                    args: [sound_path], 
                    on_started: proc => { if (typeof on_got_pid === 'function') on_got_pid(proc.pid); },
                });
            }
            throw_if_killed();
            // no cache
            const exec_res = await execute('/bin/bash', {
                args: ['-c', `"${app_path}" ${text_escaped} | aplay`],
                on_started: proc => { if (typeof on_got_pid === 'function') on_got_pid(proc.pid); },
            });
            if (exec_res?.code !== 0) {
                throw {error: 'exec-error', exec_res};
            }
            return {done: 1, exec_res};
        }
    }
    catch (reason) {
        if (reason?.killed || typeof on_query_killed === 'function' && on_query_killed() === true) {
            console.warn('linux_AquesTalkPi killed ; reason :', reason);
            throw {killed: true, reason};
        }
        console.warn('linux_AquesTalkPi error :', reason);
        throw {reason};
    }
    
}

async function is_aquestalkpi_available(message, lang, conf) {
    const avail = process.platform === 'linux' 
        // && lang.toLowerCase() === 'ja'    // <-- raspberry pi doesn't like it
        && conf?.app_path 
        && fs.existsSync(conf?.app_path);
    console.warn('[AquesTalkPi] is', avail? 'available': 'NOT available');
    return avail;
}

module.exports = {
    speak_plugin_name: 'AquesTalkPi',
    main: aquestalkpi,
    is_available: is_aquestalkpi_available,
};
