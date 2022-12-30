"use strict";

const JSON5 = require('json5');
const fs = require('fs');
const path = require('path');

function config_loader(conf_dir, conf_file_name) {
    const conf_json = fs.readFileSync(path.join(conf_dir, conf_file_name), 'utf8');
    let conf = JSON5.parse(conf_json);

    const process_obj = in_obj => {
        if (Array.isArray(in_obj)) {
            for (let i = 0; i < in_obj.length; ++i) {
                const val = in_obj[i];
                if (typeof val === 'object' && val !== null) {
                    process_obj(val);
                }
                else if (typeof val === 'string') {
                    const mat = val.match(/^@file:(.*)$/);
                    if (mat) {
                        const filename = mat[1];
                        const body = fs.readFileSync(path.join(conf_dir, filename), 'utf8');
                        in_obj[i] = filename.match(/\.json5?$/) ? JSON5.parse(body) : body;
                    }
                }
            }
        }
        else for (const key of Object.keys(in_obj)) {
            const val = in_obj[key];
            if (typeof val === 'object' && val !== null) {
                process_obj(val);
            }
            else if (typeof val === 'string') {
                const mat = val.match(/^@file:(.*)$/);
                if (mat) {
                    const filename = mat[1];
                    const body = fs.readFileSync(path.join(conf_dir, filename), 'utf8');
                    in_obj[key] = filename.match(/\.json5?$/) ? JSON5.parse(body) : body;
                }
            }
        }
    };
    process_obj(conf);
    return conf;
}

module.exports = config_loader;
