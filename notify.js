const {EventEmitter} = require("events");
const {Queue} = require('./queue');
const NotifyQitem = require('./notify-qitem');

const crypto = require('crypto');

function sha1(of_what) {
    const shasum = crypto.createHash('sha1');
    shasum.update(JSON.stringify(of_what));
    return shasum.digest('hex');
}

class Notify extends EventEmitter {
    constructor() {
        super();

        this._queue = new Queue();
        this._queue.on('item-run-started', ({item}) => {
            // console.log('[notify-event] started', item);
            this.emit('started', {item});
        });
        const on_end_event = (item, status) => {
            // console.log('[notify-event] ended', item, status);
            this.emit('ended', {item, status});
        };
        this._queue.on('item-run-killed', ({item}) => { on_end_event(item, 'killed'); });
        this._queue.on('item-run-error', ({item}) => { on_end_event(item, 'error'); });
        this._queue.on('item-run-finished', ({item}) => { on_end_event(item, 'finished'); });

        this._timers = {}; // uniqid:TIMER_ID pairs
        this._is_muted = false;
        this._rate_limits = {}; // uniqid:RATE_LIMIT_END_DATE_OBJ pairs
        const purge_interval = 1000;
        setInterval(() => {
            this._purge_expired();
        }, purge_interval);
    }
    get queue_status() {
        return this._queue.status; // returns "running", "suspended" or null (unknown)
    }
    async queue_suspend(kill_running_item=false) {
        console.log("queue suspend");
        return await this._queue.suspend(kill_running_item);
    }
    async queue_resume() {
        console.log("queue resume");
        return await this._queue.resume();
    }
    async queue_step() {
        console.log("queue step (run-once)");
        return await this._queue.run_once();
    }
    get items() { 
        return {
            queue_status: this.queue_status,

            pending: this._queue.items.map(item => {
                return {
                    uniqid: item.user_data.metadata?.uniqid,
                    message: item.user_data.message,
                    originated_from: item.user_data.originated_from,
                    tags: item.user_data.tags,
                };
            }),

            nags: Object.entries(this._timers).map(en => {
                const [uniqid, t] = en;
                const nag_type = 'until_date' in t ? 'until_date' :
                    'remain_count' in t ? 'remain_count' : 
                    '';
                const {message, tags, originated_from, once_per_n_mins} = t.details;
                const rate_limit_status = this._get_rate_limit_status(uniqid);
                return {
                    uniqid,
                    nag_type,
                    [nag_type]: t[nag_type] instanceof Date ? t[nag_type].toUTCString() : t[nag_type],
                    message,
                    tags,
                    originated_from,
                    once_per_n_mins, // rate limit frequency
                    rate_limit: rate_limit_status instanceof Date ? rate_limit_status.toUTCString() : null,
                        // ^ rate limit reset date
                };
            }),
        };
    }
    get is_muted() { return this._is_muted; }
    mute() { this._is_muted = true; }
    unmute() { this._is_muted = false; }

    _get_rate_limit_status(uniqid) {
        if (! uniqid) {
            return null;
        }
        const mute_until = this._rate_limits[uniqid];
        if (mute_until && mute_until instanceof Date) {
            if (new Date > mute_until) {
                delete this._rate_limits[uniqid];
                // no longer rate limited
                return false;
            }
            else {
                // is currently rate limited
                return this._rate_limits[uniqid];
            }
        }
        // not rate limited
        return false;
    }

    static default_uniqid(message, {tags, originated_from}={}) {
        return sha1({message, tags, originated_from});
    }
    async notify_once(message, {uniqid, tags, urgency, originated_from, once_per_n_mins}={}) {
        if (! uniqid) {
            uniqid = this.constructor.default_uniqid(message, {tags, originated_from});
            console.warn(`uniqid for message(${message}) is :`, uniqid);
        }
        if (typeof tags === 'undefined') {
            tags = [];
        }
        if (typeof once_per_n_mins === 'number' && once_per_n_mins > 0) {
            const rate_limit_status = this._get_rate_limit_status(uniqid);
            if (rate_limit_status) {
                console.warn(`⌛ SKIPPED : message(${message}, uniqid=${uniqid}) is rate limited until : ${rate_limit_status}`);
                return;
            }
            this._rate_limits[uniqid] = new Date(Date.now() + once_per_n_mins * 60 * 1000);
            console.warn(new Date, `message(${message}, uniqid=${uniqid}) will be rate limited until : ${this._rate_limits[uniqid]}`);
        }
        const metadata = {
            uniqid,
        };
        await this._queue.enqueue(new NotifyQitem(
            message, {tags, originated_from, metadata}
        ), urgency);

        return uniqid;
    }
    notify_until(until_date, frequency_mins, message, {uniqid, tags, urgency, originated_from, once_per_n_mins}={}) {
        if (! uniqid) {
            uniqid = this.constructor.default_uniqid(message, {tags, originated_from});
            console.warn('no uniqid specified, generating a new one ; you will not be able to manually remove() this message :', uniqid);
        }
        const on_timer = () => {
            if (this._is_muted) {
                console.warn('muting', message);
                return;
            }
            this.notify_once(message, {tags, uniqid, urgency, originated_from, once_per_n_mins});
        };
        on_timer();
        if (uniqid in this._timers){ 
            this.remove(uniqid);
        }
        const details = {
                message,
                tags,
                originated_from,
                once_per_n_mins,
            };
        this._timers[uniqid] = {
            timer_obj: setInterval(on_timer, frequency_mins * 60 * 1000),
            until_date,
            details,
        };
        this.emit('nag-register', {uniqid, nag_type: 'until_date'});
        console.log(`[notify_until] until: ${until_date} , frequency_mins: ${frequency_mins} , details:`, details);
        return uniqid;
    }
    notify_for_n_minutes(minutes, frequency_mins, message, {uniqid, tags, urgency, originated_from, once_per_n_mins}={}) {
        const until_date = new Date( Date.now() + minutes * 60 * 1000);
        return this.notify_until(until_date, frequency_mins, message, {uniqid, tags, urgency, originated_from, once_per_n_mins});
    }
    notify_n_times(times, frequency_mins, message, {uniqid, tags, urgency, originated_from, once_per_n_mins}={}) {
        if (! uniqid) {
            uniqid = this.constructor.default_uniqid(message, {tags, originated_from});
            console.warn('no uniqid specified, generating a new one ; you will not be able to manually remove() this message :', uniqid);
        }
        const on_timer = () => {
            if (this._is_muted) {
                console.warn('muting', message);
                return;
            }
            this.notify_once(message, {tags, uniqid: uniqid, urgency, originated_from, once_per_n_mins});
            console.log(`timers[uniqid="${uniqid}"] =`, this._timers[uniqid]);
            const remain_count = this._timers[uniqid].remain_count;
            if (typeof remain_count === 'number') {
                this._timers[uniqid].remain_count -= 1;
                if (this._timers[uniqid].remain_count <= 0) {
                    console.log(`message ${uniqid} count depleted (${remain_count}) and is being purged`);
                    this.remove(uniqid);
                }
            }
        };
        if (uniqid in this._timers){ 
            this.remove(uniqid);
        }
        const timer_freq = frequency_mins * 60 * 1000
        console.log('timer freq (msec)', timer_freq);
        const details = {
                message,
                tags,
                originated_from,
                once_per_n_mins
            };
        this._timers[uniqid] = {
            timer_obj: setInterval(on_timer, timer_freq),
            remain_count: times,
            details,
        };
        this.emit('nag-register', {nag_type: 'remain_count', uniqid});
        console.log('triggering for the first time');
        on_timer();
        console.log(`[notify_n_times] remain_count: ${remain_count} , frequency_mins: ${frequency_mins} , details:`, details);
        return uniqid;
    }
    remove(uniqid) {
        if (! (uniqid in this._timers)) {
            console.warn(`uniqid ${uniqid} not found`);
            return;
        }
        console.warn(`remove repeating nag : ${uniqid}`);
        const t = this._timers[uniqid];
        clearInterval(t.timer_obj);
        delete this._timers[uniqid];

        this.emit('nag-remove', {uniqid});
    }
    _purge_expired() {
        for(const [uniqid, t] of Object.entries(this._timers)) {
            if (t.until_date && t.until_date instanceof Date && (new Date) >= t.until_date) {
                console.log(`message ${uniqid} has expired and is being purged`);
                delete this._timers[uniqid];
            }
        }
    }
}

module.exports = Notify;


