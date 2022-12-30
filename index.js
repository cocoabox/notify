#!/usr/bin/env node

"use strict";

const MqttNotify = require('./mqtt-notify');

let mqtt_notify;

const end = () => {
    console.log('exiting');
    if (mqtt_notify) {
        mqtt_notify.close().then(()=>{
            process.exit(0);
        });
    }
    else {
        process.exit(0);
    }
};

process.on('SIGTERM', end);
process.on('SIGINT', end);

mqtt_notify = new MqttNotify();

