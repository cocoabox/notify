"use strict";

const nodemailer = require('nodemailer');

async function mailto(message, tags, config) {
    const {emit_tags} = config;
    const default_mailto = config?.mailto;
    const addresses = [].concat(
        tags.map(t => t.match('/^mailto:(.*)$')?.[1]).filter(t => !!t),
        Array.isArray(default_mailto) ? default_mailto: [default_mailto]
    ).filter(a => !! a);

    if (addresses === 0) {
        console.warn('[mailto] no #mailto:XXX tags and no default mailto addresses found in config');
        throw {error: 'no-address'};
    }
    const transporter = nodemailer.createTransport(Object.assign(
        { secure: true, auth: { user: config?.user, pass: config?.password } },
        config?.service ? { service: config.service } : {},
        config?.host ? { host: config.host } : {},
        config?.port ? { port : config.port } : {},
    ));

    const tags_str = tags.map(t => `#${t}`).join(' ');
    const mail_body = `This is a notification sent by the notify app/mailto plugin.\n-----\n${message}\n${emit_tags ? tags_str : ''}\n-----\nDate: ${(new Date).toLocaleString()}`;

    const subject = tags.includes('critical') ? '🔥 Critical notification issued' :
        tags.includes('warn') ? '⚠️  Warning issued' :
        'Notification issued';

    const info = await transporter.sendMail({
        from: config.user,
        to: addresses.join(','),
        subject,
        text: mail_body,
    });

    console.log("Message sent :", info.response);
    return {done: 1, addresses};
}

module.exports = {
    plugin_name: 'mailto',
    enabled_by_default: false,
    main: mailto,
};
