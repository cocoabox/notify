//
// voice synthesis plugin using Voicevox API (voicevox engine)
// the voicevox engine may be hosted locally, on another raspberry pi, or on a pc/mac.
//
// to install voicevox engine on raspberry pi (arm64), see ../../tools/voicevox-docker-respi/*
//
"use strict";

const fs = require('fs');
const path = require('path');
const os = require('os');
const child_process = require('child_process');
const axios = require('axios');
const QueryString = require('querystring');
const Queue = require('queue-promise');
const execute = require('../../execute');
const crypto = require('crypto');

function sha1(of_what) {
    const shasum = crypto.createHash('sha1');
    shasum.update(JSON.stringify(of_what));
    return shasum.digest('hex');
}

const concurrent_api_call = 1;

async function get_speaker_id(speaker_tag, host)    {
    const mat = speaker_tag.match( /^(.*?)([:\/\-\|](.*))?$/);
    const who = mat?.[1];
    const style = mat?.[3];
    try {
        if (! who) {
            throw new Error(`unknown speaker ; expecting "NAME" or "NAME|STYLE" ; got: ${speaker_tag}`);
        }
        const response = await axios.get(`http://${host}/speakers`);
        const speakers_arr = response?.data;
        if (! Array.isArray(speakers_arr)) {
            throw new Error('was expecting Voicevox engine to reply with an array');
        }
        const speaker_obj = speakers_arr.find(sa => sa?.name === who);
        if (! speaker_obj) {
            throw new Error(`speaker (name=${who}) not found`);
        }
        if (style) {
            // user has requested a speech style
            const wanted_style_obj = speaker_obj.styles?.find( s => s.name === style );
            if (wanted_style_obj) {
                const wanted_style_id = wanted_style_obj?.id;
                return wanted_style_id
            }
        }
        // return first style
        const style_obj = speaker_obj.styles?.[0];
        const style_id = style_obj?.id;
        console.log('using default first style :', style_obj);
        return style_id;

    }
    catch(error) {
        console.warn('failed to get speaker id because :', error);
        return null;
    }
}

async function get_synthesised_buffer(text, {speaker, host}={}) {
    if (! speaker) speaker = 1;
    if (! host) host = '127.0.0.1:50021';

    const q = QueryString.stringify({ speaker, text });
    const response = await axios.post(`http://${host}/audio_query?${q}`);
    const speech_data = response?.data;
    const response2 = await axios.request({
        method:'post',
        url: `http://${host}/synthesis?speaker=${speaker}`, 
        data: JSON.stringify(speech_data),
        headers: {
            'Content-type': 'application/json',
        },
        responseType: 'arraybuffer'
    });
    return response2?.data; 
}

function aplay_buffer(buffer, {on_got_pid}={}) {
    return new Promise((resolve, reject) => {
        const aplay = child_process.spawn('aplay', [])
            .on('exit', (code) => {
                if (code === 0) resolve();
                else reject({code});
            });
        if (typeof on_got_pid === 'function') on_got_pid(aplay.pid);
        aplay.stdin.write(bufefr);
    });
}



async function play_buffer(buffer, {on_got_pid}={}) {
    if (process.platform === 'darwin') {
        const tmp_dir = fs.mkdtempSync(`${os.tmpdir()}${path.sep}`);
        const file_path = path.join(tmp_dir, 'sound.wav');
        fs.writeFileSync(file_path, buffer);
        await afplay_file(file_path, {on_got_pid});
        fs.rmSync(tmp_dir, { recursive: true });
    }
    else if (process.platform === 'linux') {
        return aplay_buffer(buffer, {on_got_pid});
    }
}

function get_cache_filename(cache_dir, message, tags, speaker) {
    return cache_dir ? path.join(cache_dir, sha1({plugin:'voicevox', message, tags, speaker}) + '.wav') : '';
}

function split_message(message) {
    return message.split('。').map(m => m.trim()).filter(m => !!m);
}

// split passage into fragments, for each fragment query voicevox and get wave buffer, then write
// to buffer file
function synthesize_splitted(message, tags, cache_dir, {speaker, host, on_query_killed}={}) {
    const QUERY_KILL_INTERVAL = 300; // msec
    const splitted = split_message(message);
    return new Promise((resolve, reject) => {
        const queue = new Queue({start: false, concurrent: concurrent_api_call});
        let killed = false;
        splitted.forEach( message_fragment => {
            console.log(`[synthesize_splitted] enqueue promise for : ${message_fragment}`);
            queue.enqueue(async () => {
                const cache_filename = get_cache_filename(cache_dir, message_fragment, tags, speaker);
                let secs;
                let sec_per_char; 
                if (fs.existsSync(cache_filename)) {
                    console.log(`[synthesize_splitted] cache hit : ${message_fragment}`);
                }
                else 
                {
                    let api_error;
                    try {
                        console.log(`[synthesize_splitted] synthesize : ${message_fragment}`);
                        const time_start = Date.now();
                        const buffer = await get_synthesised_buffer(message_fragment, {speaker, host}); // << --- lengthy 
                        secs = ( Date.now() - time_start ) / 1000;
                        sec_per_char = Math.round(secs / message_fragment.length * 1000);
                        console.log(`[synthesize_splitted] DONE in ${secs} sec ; ${sec_per_char} msec/char ; ${message_fragment}`);
                        fs.writeFileSync(cache_filename, buffer);
                        
                        if (typeof on_query_killed === 'function' && on_query_killed()) {
                            killed = true;
                            console.log('[synthesize_splitted] recceived kill signal!');
                            throw {killed: true};
                        }
                    }
                    catch (error) {
                        if (error?.killed) {
                            killed = true;
                        }
                        console.log(`[synthesize_splitted] an error was threw while synthesizing : ${message}`, error);
                        throw {error, killed: error?.killed };
                    }
                }
                return {cache_filename, message_fragment, secs, sec_per_char};
            });
        });
        let resolutions = [];
        let rejections = [];
        const stop_if_killed = () => {
            if (killed) {
                console.warn('[synthesize_splitted] 🔪 requested; stopping ');
                queue.stop();
            }
        };
        queue.on('reject', reason => {
            console.log('[synthesize_splitted] reject :', reason);
            rejections.push(reason);
            stop_if_killed();
        });
        queue.on('resolve', res => {
            resolutions.push(res);
            stop_if_killed();
        });
        queue.on('end', () => {
            console.log("[synthesize_splitted] end ; killed =", killed);
            if (rejections.length) {
                (rejections.length === 0 ? resolve: reject)({splitted, error: rejections.length, resolutions, rejections});
            }
            else {
                resolve({splitted, done: true, resolutions});
            }
        });
        queue.on('stop', () => {
            console.log("[synthesize_splitted] stop ; killed =", killed);
            if (killed) {
                console.warn('[synthesize_splitted] 🔪 queue was stopped');
                reject({stopped: true, rejections, resolutions});
            }
        });
        try {
            queue.start();
        }
        catch (err) {
            console.warn("!@#@#%!@#$!@#$!@# ERR: ", err);
            throw err;
        }

    });
}

function aplay_file(filename, {on_got_pid}={}) {
    // returns Promise
    return execute('aplay', {
        args: [filename], 
        on_started: proc => {
            console.log(`[aplay_file] process ${proc.pid} started`);
            if (typeof on_got_pid === 'function') on_got_pid(proc.pid);
        },
    });
}

function afplay_file(filename, {on_got_pid}={}) {
    // returns Promise
    return execute('afplay', {
        args: [filename], 
        on_started: proc => {
            console.log(`[afaplay_file] process ${proc.pid} started`);
            if (typeof on_got_pid === 'function') on_got_pid(proc.pid); 
        },
    });
}

async function play_file(filename, {on_got_pid}={}) {
    if (process.platform === 'darwin') {
        return await afplay_file(filename, {on_got_pid});
    }
    if (process.platform === 'linux') {
        return await aplay_file(filename, {on_got_pid});
    }
}

function play_wavs(wav_paths, {on_got_pid, on_query_killed}={}) {
    return new Promise((resolve, reject) => {
        const queue = new Queue({start: false, concurrent: 1});
        let query_kill_responded = false;
        wav_paths.forEach(wav_path => {
            queue.enqueue(async ()=> {
                await play_file(wav_path, {on_got_pid}); 
                if (query_kill_responded || (typeof on_query_killed === 'function' && on_query_killed() === true)) {
                    console.log("[play_wavs] 🔪  on_query_killed triggered ; throwing");
                    query_kill_responded = true;
                    throw {killed: true};
                }
            });
        });
        let resolutions = [];
        let rejections = [];
        queue.on('reject', reason => {
            console.log('[play_wavs] got rejection :', reason, '; query_kill_responded :', query_kill_responded);
            rejections.push(reason);
            if (query_kill_responded || reason?.killed || reason?.signal) {
                console.warn('[play_wavs] stopping queue becuase of interruption');
                queue.clear();
                queue.stop();
            }
        });
        queue.on('resolve', res => {
            resolutions.push(res);
        });
        queue.on('end', () => {
            if (rejections.length) {
                resolve({error: rejections.length, resolutions, rejections});
            }
            else {
                resolve({done: true, resolutions});
            }
        });
        queue.on('stop', () => {
            if (query_kill_responded) { 
                console.log("[play_wavs] 🔪 🛑 queue was stopped");
                resolve({stopped: true, resolutions, rejections});
            }
        });

        queue.start();
    });
}

async function voicevox(message, tags, lang, conf, {on_got_pid, on_query_killed, set_doing_lengthy_stuff}={}) {
    const {execute, sound_path_from_tags, cache_dir, escape_shell} = this;
    const {app_path} = conf;
    console.log(`[voicevox] ${message} ; with tags :`, tags);

    const tell_em_we_are_doing_lengthy_stuff = are_we => {
        if (typeof set_doing_lengthy_stuff === 'function') set_doing_lengthy_stuff(are_we);
    };

    //if (lang !== 'ja') {
    //    console.warn(`aquestalkpi: expecting japanese text but got : ${lang}`);
    //    throw {error: 'wrong-language'};
    //}

    const throw_if_killed = () => {
        if (typeof on_query_killed === 'function' && on_query_killed() === true) {
            console.warn('🔪 voicevox() aborted because kill');
            throw {killed: true};
        }
    }

    let {host, speaker} = conf;
    if (! host) {
        throw new Error('conf.host is empty');
    }

    // determine speaker from tags
    const speaker_tag = tags.map(t => (t+'').match(/^speaker:(.*)$/)?.[1]).filter(n => !! n)?.[0];
    if (speaker_tag) {
        if (speaker_tag.match(/^[0-9]+$/)) {
            speaker = parseInt(speaker_tag);
        }
        else {
            // e.g. "speaker:九州そら|ノーマル"
            speaker = await get_speaker_id(speaker_tag, host);
        }
    }
    else {
        // no speaker tag; use speaker from conf
        if (typeof speaker === 'string') {
            speaker = await get_speaker_id(speaker_tag, host);
        }
    }

    if (! speaker) {
        speaker = 1;
    }

    // split message into fragments
    try {
        if (cache_dir) {
            let wavs = [];
            // enqueue notice tone
            const sound_path = sound_path_from_tags(tags);
            if (sound_path) {
                console.log('## notice tone');
                wavs.push(sound_path);
            }

            console.log('## synthesize wave for each fragment');
            tell_em_we_are_doing_lengthy_stuff(true);
            const {splitted, resolutions} = await synthesize_splitted(
                message, tags, cache_dir, {speaker, host, on_query_killed}); // <--- lengthy
            tell_em_we_are_doing_lengthy_stuff(false);
            console.log('voicevox : synthesize_splitted ended');

            // kill check point
            throw_if_killed();

            splitted.forEach(frag => {
                const cache_filename = resolutions.find(r => r.message_fragment === frag)?.cache_filename;
                console.log(`queuing ${cache_filename} : ${frag}`);
                wavs.push(cache_filename);
            });

            // play each fragment
            console.log('## play each fragment');
            const play_wavs_res = await play_wavs(
                wavs, {on_got_pid, on_query_killed}); // <<--- lengthy 
        }
        else {
            // no cache saving ; generate everything on one go
            const sound_path = sound_path_from_tags(tags);
            if (sound_path) {
                await play_file(sound_path, {on_got_pid});
            }
            throw_if_killed();
            const ab = await get_synthesised_buffer(voice, message, {speaker, host, throw_if_killed});
            const exec_res = await play_buffer(new Buffer(ab), {on_got_pid});
            return {done: 1, exec_res};
        }

    }
    catch (reason) {
        console.warn('voicevox error :', reason);
        if (reason?.killed || typeof on_query_killed === 'function' && on_query_killed() === true) {
            tell_em_we_are_doing_lengthy_stuff(false);
            console.warn('voicevox killed ; reason :', reason);
            throw {killed: true, reason};
        }
        throw {reason};
    }


}

async function is_api_available(message, lang, conf) {
    if (conf?.host) {
        const res = await axios.request({
            method: 'get',
            url: `http://${conf.host}/version`,
        });
        return typeof res.data === 'string';
    }
    else {
        return false;
    }
}

module.exports = {
    speak_plugin_name: 'voicevox_client',
    main: voicevox,
    is_available: is_api_available,
};
