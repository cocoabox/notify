const child_process = require('child_process');
const readline = require('readline');

/**
 * シェルコマンドを実行する
 * @param {string} command
 * @param {{spawn_opts:object, args:string[], on_stdout:function, on_stderr: function, on_started: function}} options
 * @param {string[]} options.args command line arguments
 * @param {object} options.spawn_opts see : https://nodejs.org/api/child_process.html#child_process_child_process_spawn_command_args_options
 * @param {boolean} options.start_only : if TRUE, then the promise will resolve once the process has started
 * @param {function} options.on_closed
 * @returns {Promise<{code:number,stdout:string[],stderr:string[]}>}
 */
function execute(command, options = {}) {
    options = Object.assign({
        args: [],
        on_stdout: null,
        on_stderr: null,
        on_started: null,
        start_only: false,
        on_closed: null,
    }, options);
    console.log('🏃', command, options.args.join(' '));
    let spawn_opts = options && typeof options.spawn_opts === 'object'
        ? options.spawn_opts
        : {};
    return new Promise(
        (resolve, reject) => {
            let stdout = [];
            let stderr = [];

            let proc = child_process.spawn(command, options.args, spawn_opts);
            const {pid} = proc;
            if (typeof options.on_started === 'function') {
                options.on_started(proc);
            }
            readline.createInterface(
                {
                    input: proc.stdout.setEncoding('utf8'),
                    terminal: false
                }).on('line', (line) => {
                if (typeof options.on_stdout === 'function') {
                    options.on_stdout(line, proc);
                }
                stdout.push(line);
            });
            readline.createInterface(
                {
                    input: proc.stderr.setEncoding('utf8'),
                    terminal: false
                }).on('line', (line) => {
                if (typeof options.on_stderr === 'function') {
                    options.on_stderr(line, proc);
                }
                stderr.push(line);
            });
            proc.on('close', (code) => {
                const signal = proc.signalCode;
                if (typeof options.on_closed === 'function') {
                    options.on_closed({code, stdout, stderr, signal});
                }
                if (options.start_only) {
                    // do nothing
                } else {
                    if (code === 0) {
                        resolve({code, stdout, stderr, signal});
                    } else {
                        reject({code, stdout, stderr, signal});
                    }
                }
            });
            if (options.start_only) {
                const kill = (signal = 'SIGHUP') => {
                    process.kill(pid, signal);
                };
                resolve({started: true, stdout, stderr, proc, kill})
            }
        }
    );
}

module.exports = execute;
