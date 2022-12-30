"use strict";

const {EventEmitter} = require("events");

class Qitem {
    reset() {
        this._status = 'idle';
        this._is_killed = false;
    }
    kill() {
        return new Promise(async (resolve, reject) => {
            this._is_killed = true;
            try {
                await this._kill();
                this._status = 'killed';
                resolve();
            } 
            catch(reason) {
                console.warn('failed to kill Qitem because :', reason);
                reject({error: reason});
            }
        });
    }
    execute() {
        return new Promise(async (resolve, reject) => {
            this._status = 'executing';
            try {
                console.log("calling _execute()");
                const _execute_result = await this._execute();
                console.log("_execute_result: ",_execute_result);
                this._status = 'idle';
                if (this._is_killed) {
                    console.warn("_executed ended, was killed");
                    return resolve({killed:1});
                }
                return resolve({done: 1});
            } 
            catch(exec_error) {
                return reject({error:'exception', exception: exec_error});
            }
        });
    }
    _execute() {
        // User should implement their own _execute() method
        return new Promise((resolve) => {
            resolve();
        });
    }
    _kill() {
        // User should implement their own _kill() method
        return new Promise((resolve) => {
            resolve();
        });
    }
    constructor(user_data) {
        this._user_data = user_data;
        this._status = 'idle';
        this._is_killed = false;
    }
    get user_data() { return this._user_data; }
    get status() { return this._status; }
    get is_killed() { return this._is_killed; }
}

class Queue extends EventEmitter {
    constructor() {
        super();
        this._items = [];
        this._is_running = false;
        this._is_suspend = false;
        this._suspend_pending_resolve_func = null;
        this._run_once = false;
        this._running_item = null;
    }
    get items() {
        return this._items.map(i => i.qitem);
    }
    find(callback) {
        return this._items.find(callback);
    }
    get is_running() {
        return this._is_running;
    }
    get is_suspended() {
        return this._is_suspend;
    }
    get status() {
        const status = this._is_running && (! this._is_suspend) ? "running" 
            : (! this._is_running) && this._is_suspend ? "suspended" 
            : (! this._is_running) && (! this._is_suspend) ? "idle"
            : null;
        if (! status) {
            console.warn("[queue status] unknown combination",
                ", is_running:", this._is_running,
                ", is_suspend:", this._is_suspend);
        }
        return status;
    }
    get running_item() {
        return this._running_item?.qitem;
    }
    _sort() {
        this._items.sort((a,b) => a.prio_number - b.prio_number);
    }
    /**
     * @param {Qitem} qitem
     *         
     * @param {number|boolean} urgency
     *      true .. interrupts current item, then start running this task now
     *      false (default) .. appends task to end of queue
     *      number .. insert item to end of queue MINUS x (where x is uregency value)
     * @return {Promise}
     *      resolves if job is enqueued
     */
    async enqueue(qitem, urgency=false) {
        // type checks
        if (! ['number', 'boolean'].includes(typeof urgency)) {
            throw new TypeError('expecting urgency to be either a number or boolean');
        }
        if (! (qitem instanceof Qitem)) {
            throw new TypeError('expecting qitem to be instance of Qitem');
        }
        let qitem_to_kill;

        // assign priority number based on given urgency
        let prio_number;
        console.log("urgency :", urgency);
        if (urgency === true) {
            const current_min_prio_number = Math.min.apply(null, this._items.map(j => j.prio_number) );
            console.log("urgent queue ; current min prio_number is :", current_min_prio_number);
            prio_number = current_min_prio_number - 1;
           
            if (this._running_item) {
                qitem_to_kill = this._running_item.qitem;
            }
        }
        else if (typeof urgency === 'number') {
            prio_number = this.constructor.next_seq - urgency;
        }
        else {
            prio_number = this.constructor.next_seq;
        }
        console.log('prio_number :', prio_number);
        const item = {
            qitem,
            prio_number,
        };
        this._items.push(item);
        this.emit('enqueued', {item});
        console.log('enqueued', item); 

        // sort based on prio_number
        this._sort();

        // kill existing if wanted
        if (qitem_to_kill) {
            console.warn('killing existing item');
            await qitem_to_kill.kill();
        }
        // start running queue if not so
        if (this._is_suspend) {
            console.warn('[enqueue] task enqueued but currently suspended; plz call resume()');
            return {enqueued:true, suspended: true};
        }
        else {
            const run_queue_promise = this.start_running();
            // run_queue_promise will resolve once the current queue is all finished (or suspended)
            return {enqueued:true, run_queue_promise};
        }
    }
    async suspend(kill_running_item=false) {
        console.warn('[suspend] begin');
        this._is_suspend = true;
        if (! this._is_running) {
            console.warn('[suspend] not running ; nothing else to do');
            return;
        }
        const suspend_pending_promise = new Promise(resolve => {
            this._suspend_pending_resolve_func = resolve;
        });
        const promises_to_wait = [suspend_pending_promise];

        if (kill_running_item && this._running_item) {
            // we don't need to put the job back because at the run-loop, a killed task
            // is automatically put back
            const kill_promise = this._running_item.qitem.kill();
            promises_to_wait.push(kill_promise);
        }
        try {
            console.warn('[suspend] waiting for promises_to_wait');
            await Promise.all(promises_to_wait);
            console.warn('[suspend] all done');
            return {done: true};
        }
        catch (reason) {
            console.warn('[suspend] failed to kill existing running item');
            throw {error:reason};
        }
    }
    async resume() {
        this._is_suspend = false;
        if ( this._items.length > 0) {
            return await this.start_running();
        }
    }
    async run_once() {
        if (this._is_suspend && this._items.length > 0) {
            this._run_once = true;
            return await this.start_running();
        }
        else {
            console.warn('[resume] cannot run-once because not currently suspend/pending job list is empty');
            return {done:0, error:'not-suspened'};
        }
    }
    static get next_seq() {
        if (typeof this._seq !== 'number') this._seq = 0;
        return ++this._seq;
    }
    /**
     * remove one item from the queue
     * @param {function} qitem_filter_function
     *      is function({qitem}) {..} ; should return True if user wants to dequeue this qitem
     */
    dequeue_where(qitem_filter_func) {
        for (let i = this._items.length - 1; i >= 0; i--) {
            const qitem = this._items[i].qitem;
            const want_dequeue = qitem_filter_func(qitem);
            if (want_dequeue) {
                const dequeued = this._items.splice(i, 1);
                this.emit('dequeued', {qitem: dequeued});
            }
        }
    }
    async start_running() {
        if (this._is_running) {
            console.log("already running, exit");
            return {already_running: true};
        }
        this.emit('run-started');
        this._is_running = true;
        this._is_suspend = false;
        let how_did_we_break;
        while (true) {
            console.log("remaining items :", JSON.stringify(this._items));
            if (this._items.length == 0) {
                console.log('no more items in queue');
                how_did_we_break='no-more-items';
                break;
            }
            this._running_item = this._items.shift();
            console.log("now running", JSON.stringify(this._running_item));
            try {
                this.emit('item-run-started', {item: this._running_item.qitem});
                const exec_result = await this._running_item.qitem.execute();
                console.log("qitem execute() result:", exec_result);
                if (exec_result?.killed) {
                    this._running_item.qitem.reset();
                    console.log("run item killed; putting back to queue:", this._running_item);
                    this._items.push(this._running_item);
                    this._sort();
                    const ran =  this._running_item.qitem;
                    this._running_item = null;
                    this.emit('item-run-killed', {item: ran});
                }
                else {
                    const ran =  this._running_item.qitem;
                    this._running_item = null;
                    this.emit('item-run-finished', {item:ran});
                }
            } 
            catch (reason) {
                console.log("run item error", reason);
                this.emit('item-run-error', {item: this._running_item.qitem, reason});
            }
            this._running_item = null;
            if (this._is_suspend ) {
                how_did_we_break='suspend';
                console.log("suspension requested. breaking loop");
                if (this._suspend_pending_resolve_func) {
                    this._suspend_pending_resolve_func();
                    this._suspend_pending_resolve_func = null;
                }
                break;
            }
            if (this._run_once) {
                this._run_once = false;
                this._is_suspend = true;
                how_did_we_break='run-once-finished';
                console.log("run-once finished. breaking loop");
                break;
            }
        }
        console.log("run finished");
        this._is_running = false;
        this.emit('run-finished', {end_type: how_did_we_break});

        return {end_type: how_did_we_break};
    }
}

module.exports = {
    Qitem,
    Queue,
};


