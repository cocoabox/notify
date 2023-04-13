"use strict";

const {Qitem} = require('./queue');
const execute = require('./execute');
const config_loader = require('./config-loader');

const JSON5 = require('json5');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

let plugins;

function load_plugins() {
    if (plugins) { return plugins; }

    const plugin_dir = path.join(__dirname, 'plugins');
    const is_file = filepath => (fs.statSync(filepath)).isFile();
    const requires = fs.readdirSync(plugin_dir).filter(fs => fs.match(/\.js$/)).map(fn => `./plugins/${fn}`);
    console.log('loaded plugins :',requires.join(' , '));

    const plugin_entries = requires.map(r => {
        try {
            const {plugin_name, main, enabled_by_default} = require(r);
            const is_plugin = plugin_name && typeof main === 'function';
            return is_plugin ? {plugin_name, main, enabled_by_default : enabled_by_default ?? true} : null;
        }
        catch (error) {
            console.warn('failed to load plugin :', r, error);
            return null;
        }
    }).filter(p => !!p);
    plugins = plugin_entries;
    return plugins;
}

function config() {
    return config_loader( path.join(__dirname, 'conf'), 'plugins.json5');
}

function get_plugins_from_tags(tags, plugins) {
    const filter_csv = tags.map(t => (t+'').match(/^(plugin|plugins):(.*)$/)?.[2]).filter(m => !!m);
    if (filter_csv.length === 0) {
        return {plugins, is_specific: false};
    }
    // console.log('filter_csv', filter_csv);
    const filters = filter_csv.map(f => f.split(',')).flat();
    const extracted_plugins = plugins.filter(p => filters.includes(p.plugin_name));

    return {plugins: extracted_plugins, is_specific: true};
}

class NotifyQitem extends Qitem {
    _execute() {
        console.log("calling NotifyQitem._execute()", this.user_data);
        return new Promise(async (resolve, reject) => {
            const config_obj = config();
            const all_plugins = load_plugins();
            const {message, tags} = this.user_data ?? {};
            // console.log("message :", message);
            // console.log("tags :", tags);
            const {plugins, is_specific} = get_plugins_from_tags(tags, all_plugins);
            console.log("plugins :", plugins);
            const final_plugins = is_specific ? plugins : plugins.filter(p => p.enabled_by_default);

            console.log("final_plugins :", final_plugins);
            if (! final_plugins.length) {
                console.warn('WARN: no plugins will be used to emit this message:', {message, tags});
            }

            const all_result = await Promise.all(final_plugins.map(async fp => {
                const {plugin_name, main} = fp;
                console.log('exec plugin :', plugin_name);
                try {
                    this._doing_lengthy_stuff = false;
                    const ctx = {
                        // plugin reports PID to us so we can kill the process in case
                        // interruption is required
                        on_got_pid : pid => {
                            console.log("[_execute] plugin reported PID :", pid);
                            this._pid = pid;
                        },
                        // plugin calls this func to ask us whether interruption
                        // is required
                        on_query_killed: () => {
                            if (this._is_killed) {
                                console.log("[_execute] telling process that we're killed");
                            }
                            return this.is_killed;
                        },
                        // for non-PID based lengthy process
                        // when killed, we will wait till this._doing_lengthy_stuff flag is FALSE
                        set_doing_lengthy_stuff: (doing_lengthy_stuff) => {
                            console.log("[_execute] we're informed that we're", (doing_lengthy_stuff ? "": "not"), "doing lengthy stuff");
                            this._doing_lengthy_stuff = doing_lengthy_stuff;
                        }
                    };
                    const plugin_res = await main.apply(ctx, [
                        message, tags, config_obj?.[plugin_name], ctx
                    ]);

                    console.log(`plugin ${plugin_name} succeeded :`, plugin_res);
                    return {done: 1};
                }
                catch(reason) {
                    if (reason?.killed) {
                        console.warn(`plugin ${plugin_name} was killed`);
                        return {killed: 1};
                    }
                    else {
                        console.warn(`plugin ${plugin_name} failed:`, reason);
                        return {error: reason};
                    }
                }
            }));
            if (all_result.find(ar => !! ar.killed)) {
                console.warn("🛑 at least one plugin was killed");
                return resolve({killed: true});
            }
            const errors = all_result.filter(ar => 'error' in ar);
            if (errors.length > 0) {
                console.warn("at least one error occurred", errors);
                return reject({error: errors});
            }
            console.log('all plugins ran successfuly');
            resolve({done:1, all_done: 1});
        });
    }

    _kill() {
        return new Promise (resolve => {
            try {
                if (this._pid) {
                    console.warn(`[_kill] pid #${this._pid}`);
                    process.kill(this._pid);
                    this._pid = null;
                }
            }
            catch (error) {
                console.warn(`[_kill] failed to kill pid #${this._pid} because`, error);
            }
            if (this._doing_lengthy_stuff) {
                let check_timer;
                check_timer = setInterval(() => {
                    console.log("[_kill] waiting for _doing_lengthy_stuff");
                    if (! this._doing_lengthy_stuff_doin) {
                        console.log("[_kill] DONE _doing_lengthy_stuff");
                        clearInterval(check_timer);
                        this._killed = true;
                        resolve();
                    }
                }, 1000);
            }
            else {
                console.log('[_kill] not doing lengthy stuff; kill approved');
                this._killed = true;
                resolve();
            }
        });
    }
    constructor(message, {originated_from, tags, metadata}={}) {
        const tags_array = Array.isArray(tags) ? tags : [tags];
        const user_data = {
            message,
            originated_from,
            tags: tags_array,
            metadata,
        };
        super(user_data);
    }
}

module.exports = NotifyQitem;
