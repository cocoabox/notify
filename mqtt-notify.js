const Notify = require('./notify');
const config_loader = require('./config-loader');
const JSON5 = require('json5');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const QueuePromise = require('queue-promise');

function sleep(msec) {
    return new Promise(resolve => {
        setTimeout( () => {
            resolve();
        }, msec);
    });
}

function config() {
    return config_loader(path.join(__dirname, 'conf'), 'mqtt-notify.json5');
}

function to_mins(input) {
    const multipliers= {
        minutes: 1, minute: 1, mins: 1, min: 1, m: 1,
        hours: 60, hour: 60, hrs: 60, hr: 60, h: 60,
        days: 60 * 24, day: 60 * 24, d: 60 * 24,
    };
    if (Array.isArray(input) 
        && typeof input[0] === 'number'  
        && typeof input[1] === 'string' 
        && Object.keys(multipliers).includes(input[1])
) {
        const num = input[0];
        const unit = input[1];
        const mult = multipliers[unit];
        return Math.ceil( parseFloat(num) * mult );
    }
    else if (typeof input === 'string') {
        const regex = new RegExp('^([0-9,\.]+)\\s*(' + Object.keys(multipliers).join('|') + ')$');
        const match = input.trim().toLowerCase().match(regex);
        if (match) {
            const num = match[1];
            const unit = match[2];
            const mult = multipliers[unit];
            return Math.ceil( parseFloat(num) * mult );
        }
    }
    else if (typeof input === 'number') {
        return Math.ceil( input );
    }
    console.warn(`failed to convert to mins from : ${input}`);
    return null;
};


class MqttNotify extends Notify {
    constructor(opts={}) {
        super();
        this._q = new QueuePromise({
            concurrent: 1,
            interval: 500,
        });

        opts = Object.assign({
            reconnect_after_sec: 5,
        }, opts);

        this._reconnect_after_sec = opts.reconnect_after_sec;
        this._config = config();
        this._client_cert = this._config?.client_cert;
        this._client_key = this._config?.client_key;
        this._ca = this._config?.ca;
        this._topic_prefix = this._config?.topic_prefix ?? 'notify/';
        this._broker = this._config.broker;
        this._client = '';
        this._user_initiated_close = false;

        this.on('started', ({item}) => {
            console.log('[mqtt-notify] job started', item);
            this._pub(this._topic_prefix + 'started', {
                uniqid: item.user_data.metadata.uniqid,
            }); 
            this._pub_my_status('job-started');
        });
        this.on('ended', ({item, status}) => {
            console.log('[mqtt-notify] job ended', item);
            this._pub(this._topic_prefix + 'ended', {
                uniqid: item.user_data.metadata.uniqid,
            }); 
            this._pub_my_status('job-ended');
        });
        this.on('nag-register', async ({uniqid, nag_type}) => {
            console.log('[mqtt-notify] nag registered', uniqid, nag_type);
            await this._pub(this._topic_prefix + 'nag-start', {
                uniqid, nag_type
            }); 
            await this._pub_my_status('nag-registered');
        });
        this.on('nag-remove', async ({uniqid}) => {
            console.log('[mqtt-notify] nag acknowledged', uniqid);
            await this._pub(this._topic_prefix + 'nag-acknowledged', { uniqid });
            await this._pub_my_status('nag-removed');
        });

        this._connect();
    }

    get connected() {
        return this._client?.connected;
    }

    async _on_disconnected() {
        const reconnect_sec = 5;

        await sleep(500);
        if (! this._reconnect_timer && !this._connecting) {
            this._subscribed_topics = [];
            console.log(`[MQTT] disconnected; reconnecting in ${reconnect_sec} secs`);
            this._reconnect_timer = setTimeout(() => {
                this._connect();
            }, reconnect_sec * 1000);
        }

    }

    _connect() {
        if (this.connected) return Promise.resolve({already_connected:true});
        return new Promise((resolve, reject) => {
            const reconnect_timer_stop = () => {
                if (! this._reconnect_timer) return;
                clearTimeout(this._reconnect_timer);
                this._reconnect_timer = null;

            };

            const options = Object.assign({}, {
                host: this._broker.host,
                port: this._broker.port,
                username: this._broker.username,
                password: this._broker.password,
                protocol: this._client_cert ? 'mqtts' : 'mqtt',
            }, this._client_cert && this._client_key ? {
                cert: this._client_cert,
                key: this._client_key,
                rejectUnauthorized: !! this._client_cert,
            } : {}
                , this._ca ? {
                    ca: this._ca,
                }: {}
            );

            this._connecting = true;

            if (this._client) {
                console.warn('reconnecting');
                this._client.reconnect();
            }
            else {
                console.warn('connecting to :', options.host, options.port);
                this._client = mqtt.connect(options);
            }

            this._client.on('close', async () => {
                this._connecting = false;
                reconnect_timer_stop();
                if (this._user_initiated_close) {
                    this._user_initiated_close = false;
                    return;
                }
                await this._on_disconnected();
            });


            this._client.on('connect', async () => {
                console.warn('connected');
                this._connecting = false;
                reconnect_timer_stop();
                const topics_of_interest = [
                    this._topic_prefix + 'do/#',
                ];
                this._client.subscribe(topics_of_interest, (err, grant) => {
                    if (err) {
                        console.warn(`failed to subscribe to ${JSON.stringify(topics_of_interest)} because :`, err);
                        setTimeout(() => {
                            console.warn('attempt reconnect');
                            this._user_initiated_close = true;
                            this._client.end();
                        }, 1000);
                    }
                    console.warn('subscribed', grant);
                });
                this._client.on('message', (topic, payload) => {
                    this._on_message(topic, payload);
                });
                resolve();
            });
        });
    }
    close(opts={}) {
        this._user_initiated_close = true;

        opts = Object.assign({force: false}, opts);
        console.log('client closing :', JSON.stringify(opts));
        return new Promise(resolve => {
            //stop mqtt client
            if (this.connected) {
                this._client.end(opts.force, opts, ()=>{
                    console.log('client closed');
                    this._client = null;
                    resolve();
                });
            }
            else {
                resolve({not_connected:true});
            }
        });
    }
    _on_message(topic, payload) {
        switch(topic) {
            case this._topic_prefix + 'do/mute':
                return this._on_do_mute();
                break;
            case this._topic_prefix + 'do/unmute':
                return this._on_do_unmute();
                break;
            case this._topic_prefix + 'do/ack':
            case this._topic_prefix + 'do/acknowledge':
                return this._on_do_acknowledge(payload.toString());
                break;
            case this._topic_prefix + 'do/query_messages':
                return this._on_do_query_messages();
                break;
            case this._topic_prefix + 'do/notify':
                return this._on_do_notify(payload.toString());
                break;
            case this._topic_prefix + 'do/suspend':
                return this._on_do_suspend(payload.toString());
                break;
            case this._topic_prefix + 'do/resume':
                return this._on_do_resume();
                break;
            case this._topic_prefix + 'do/step':
                return this._on_do_step();
                break;
            default:
                console.warn('unknown topic received :', topic);
        }
    }
    async _on_do_suspend(payload) {
        let parsed;
        try {
            parsed = JSON5.parse(payload);
        }
        catch (err) {
            parsed = {};
        }
        const {kill} = parsed;
        console.warn('suspend job queue');
        await this.queue_suspend(kill);
        this._pub(this._topic_prefix + 'queue_status', {status: this.queue_status}); 
    }
    async _on_do_step() {
        console.warn('step (run-once) job queue');
        await this.queue_step();
        this._pub(this._topic_prefix + 'queue_status', {status: this.queue_status}); 
    }
    async _on_do_resume() {
        console.warn('resume job queue');
        await this.queue_resume();
        this._pub(this._topic_prefix + 'queue_status', {status: this.queue_status}); 
    }
    _on_do_mute() {
        console.warn('mute');
        this.mute();
        this._pub(this._topic_prefix + 'mute_status', {muted: true}); 
    }
    _on_do_unmute() {
        console.warn('unmute');
        this.unmute();
        this._pub(this._topic_prefix + 'mute_status', {muted: false}); 
    }
    async _on_do_acknowledge(payload) {
        // payload: JSON or String
        // String: UNIQID_STR
        // JSON: {uniqid: UNIQID_STR}
        let uniqid;
        try {
            let parsed = JSON.parse(payload);
            uniqid = parsed.uniqid;
        }
        catch (err) {
            uniqid = '' + payload;
        }
        if (! uniqid) {
            console.warn('empty uniqid passed ; payload :', payload);
            return;
        }
        console.warn('acknowledge', uniqid);
        this.remove(uniqid);

        await this._pub(this._topic_prefix + 'acknowledged', { uniqid }); 
        this._on_do_query_messages('acknowledged');
    }

    async _on_do_notify(payload) {
        // 
        // payload: JSON or String
        //  - String: "MESSAGE #TAG1 #TAG2 #TAG3 ..."           # sends one normal-prority message with specified tags
        //  - JSON : {
        //      message: STR_WITHOUT_TAGS,
        //      tags: [TAG1, TAG2, ...],                        # do not prepand hash sign
        //      originated_from: STR,                           # reserved for future use
        //      uniqid: STR,                                    # required for acknowledging/removing a nag
        //      [OPTIONAL] urgency: BOOL | NUMBER,              # True=interrupt current queue and send this notification immediately, NUMBER=overtake N current notifications, false(default)=append to end of current notification queue
        //      [OPTIONAL] for: PERIOD,                         # only one of the following keys should he present: 
        //      [OPTIONAL] times: NUMBER,                       #  - for   - times    - until
        //      [OPTIONAL] until: DATE_STR | MSEC_TIMESTAMP,    # 
        //      [OPTIONAL] frequency: PERIOD,                   # nag frequency
        //      [OPTIONAL] once_per: PERIOD,                    # nag rate limits (once per N minutes, etc)
        //      [OPTIONAL] then: "step|resume",                 # (in case current queue is suspended) what to do after enqueing item
        //  }
        //  - where TAG is plugin-specific, non-displayed tags
        //      - "critical"
        //  - where PERIOD is either:
        //      - "NUMBER (minutes|hours|days)"
        //      - [NUMBER, "(minutes|hours|days)"]
        //      - MINUTES_NUM
        //
        let parsed;
        const get_frequency_mins = () => {
            const mins = to_mins(parsed?.frequency);
            if (mins === null) {
                console.warn(`failed to determine frequency (mins) from : ${parsed?.frequency}`);
                return null;
            }
            else return mins;
        };
        try {
            parsed = JSON5.parse(payload);
        }
        catch (error) {
            // extract message and tags from plain-text payload
            const tags = payload?.match(/#[^\s]+/g)?.map(s => s.substr(1)) ?? [];
            const message = (payload?.replaceAll(/#[^\s]+/g, '') ?? '').trim();
            parsed = { message, tags };
        }
        const {message, tags, uniqid, urgency, originated_from, once_per} = parsed;
        const once_per_n_mins = once_per && (typeof once_per === 'number' || typeof once_per ==='string')
            ? to_mins(once_per)
            : null;

        if (parsed?.until) {
            const until = parsed.until;
            let until_date;
            if (typeof until === 'number' || typeof until === 'string') {
                until_date = new Date(until);
            }
            else {
                console.warn('invalid .until value :', until, '; from :', parsed);
                return;
            }
            const freq = get_frequency_mins();
            if (! freq) {
                console.warn('invalid .frequency value :', parsed.frequency, '; from :', parsed);
                return;
            }
            if (typeof once_per_n_mins === 'number' && freq < once_per_n_mins) {
                console.warn(`WARN: desired frequency (once per ${freq} mins) is less than rate-limit (max once per ${once_per_n_mins} mins) ; some notifications will be rate-limited`);
            }
            this.notify_until(until_date, freq, message, {uniqid, tags, urgency, originated_from, once_per_n_mins});
        }
        else if (parsed?.for) {
            const for_mins = to_mins(parsed.for);
            if (! for_mins) {
                console.warn('invalid .for value :', parsed.for,'; from :', parsed);
                return;
            }
            const freq = get_frequency_mins();
            if (typeof once_per_n_mins === 'number' && freq < once_per_n_mins) {
                console.warn(`WARN: desired frequency (once per ${freq} mins) is less than rate-limit (max once per ${once_per_n_mins} mins) ; some notifications will be rate-limited`);
            }
            this.notify_for_n_minutes(for_mins, freq, message, {uniqid, tags, urgency, originated_from, once_per_n_mins});
        }
        else if (parsed?.times) {
            if (typeof parsed.times !== 'number') {
                console.warn('invalid .times value :', parsed.times,'; from :', parsed);
                return;
            }
            const times = Math.ceil(parsed.times);
            if (! times) {
                console.warn('invalid .times value (expecting > 0 value) :', parsed.times,'; from :', parsed);
                return;
            }
            const freq = get_frequency_mins();
            if (typeof once_per_n_mins === 'number' && freq < once_per_n_mins) {
                console.warn(`WARN: desired frequency (once per ${freq} mins) is less than rate-limit (max once per ${once_per_n_mins} mins) ; some notifications will be rate-limited`);
            }
            this.notify_n_times(times, freq, message,
                {uniqid, tags, urgency, originated_from}); 
        }
        else {
            await this.notify_once(message, {uniqid, tags, urgency, originated_from, once_per_n_mins});
        }

        // post-enqueue action
        if (parsed?.then === 'resume') {
            if (this.queue_status ==='suspended') {
                console.warn('resume after enqueue');
                this.queue_resume();
            }
            else {
                console.warn('[WARN] unable to resume after enqueue, because current queue_status is :', this.queue_status);
            }
        }
        else if (parsed?.then === 'step') {
            if (this.queue_status ==='suspended') {
                console.warn('step after enqueue');
                this.queue_step();
            }
            else {
                console.warn('[WARN] unable to step after enqueue, because current queue_status is :', this.queue_status," ; was expecting 'suspended'");
            }
        }
    }
    _on_do_query_messages() {
        this._pub_my_status('request-received', true);
    }
    _pub_my_status(why='', subject_to_debouncing=false) {
        if (! this._pub_my_status_debounce_statuses) {
             this._pub_my_status_debounce_statuses = {};
        }

        if (subject_to_debouncing) {
            const dont_pub_until = this._pub_my_status_debounce_statuses[why ?? ''];
            if (typeof dont_pub_until === 'number' && dont_pub_until >= Date.now()) {
                // we are in cooldown
                return;
            }
            if (typeof dont_pub_until === 'number' && Date.now() > dont_pub_until) {
                // debounce cleared
                delete this._pub_my_status_debounce_statuses[why ?? ''];
            }
            const DEBOUNCE_MINS = 5;
            this._pub_my_status_debounce_statuses[why ?? ''] = Date.now() + DEBOUNCE_MINS * 60 * 1000;
        }

        const {pending, nags } = this.items;
        const mute_status = this.is_muted;
        const running = this._queue.running_item ? {
            uniqid: this._queue.running_item.user_data.metadata.uniqid,
            message: this._queue.running_item.user_data.message, 
            tags: this._queue.running_item.user_data.tags, 
        }: null;
        const messages = { 
            running, pending, nags, mute_status };
        return this._pub(this._topic_prefix + 'messages', {
            __why__: why,
            messages,
            nag0: nags[0],
            nag1: nags[1],
            nag2: nags[2],
            pending0: pending[0],
            pending1: pending[1],
            pending2: pending[2],
        });
    }
    /**
     * enqueues to publish one MQTT message ; resolves when the message is published
     * @param {string} topic
     * @param {object|string} body
     * @param {object} opts MQTT publish opts and additional stuff; see : https://github.com/mqttjs/MQTT.js#publish
     * @param {boolean=true} opts._body_is_json   if true, will JSON stringify body; otherwise will force convert body into string
     * @param {boolean=true} opts._resolve_after_enqueue
     * @return {Promise} resolves once the message is published
     */
    _pub(topic, body, opts) {
        if (! topic) {
            throw new Error('empty topic');
        }
        opts = Object.assign({
            _resolve_after_enqueue: true,
            _body_is_json: true,
        }, opts);
        const {_resolve_after_enqueue, _body_is_json} = opts;

        return new Promise(async (finally_resolve, finally_reject) => {
            await this._connect();
            // see : https://github.com/Bartozzz/queue-promise
            const message = _body_is_json ? JSON.stringify(body, 'utf8') : `${body}`
            const message_buf = Buffer.from(message ?? '');

            const task = () => new Promise((resolve, reject) => {
                console.log('[_pub] publishing :', topic, message);
                this._client.publish( topic, 
                    message, 
                    opts, 
                    error => {
                        if (error) {
                            const rej = {error};
                            reject(rej);
                            if (! _resolve_after_enqueue) finally_reject(rej);
                        }
                        else {
                            resolve();
                            if (! _resolve_after_enqueue) finally_resolve();
                        }
                    }
                );
            });
            this._q.enqueue(task);
            if (_resolve_after_enqueue) {
                finally_resolve();
            }
        });
    }
}

module.exports = MqttNotify;
