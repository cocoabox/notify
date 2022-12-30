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
    return {plugins: plugins.filter(p => filter_csv.includes(p.plugin_name)), is_specific: true};
}

class NotifyQitem extends Qitem {
    _execute() {
        console.log("calling NotifyQitem._execute()", this.user_data);
        return new Promise(async (resolve, reject) => {
            const config_obj = config();
            const all_plugins = load_plugins();
            const {message, tags} = this.user_data;
            const {plugins, is_specific} = get_plugins_from_tags(tags, all_plugins);
            const final_plugins = is_specific ? plugins : plugins.filter(p => p.enabled_by_default);

            const all_result = await Promise.all(final_plugins.map(async fp => {
                const {plugin_name, main} = fp;
                console.log('exec plugin :', plugin_name);
                try {
                    const plugin_res = await main(message, tags, config_obj?.[plugin_name], {
                        on_got_pid : pid => { this._pid = pid; },
                        on_query_killed: () => this.is_killed,
                    });
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
        try {
            console.warn(`kill pid #${this._pid}`);
            process.kill(this._pid);
        }
        catch (error) {
            console.warn(`failed to kill pid #${this._pid} because`, error);
        }
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
