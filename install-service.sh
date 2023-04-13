#!/bin/bash
DIR="$(dirname "$(readlink -f "$0")")"

MOSQUITTO_COMMENT='#'
if systemctl status mosquitto >/dev/null; then
  MOSQUITTO_COMMENT=''
fi

cat "$DIR"/notify.service.template \
  | sed 's|DIR|'$DIR'|' | sed 's|MOSQUITTO_COMMENT|'$MOSQUITTO_COMMENT'|' \
  > /etc/systemd/system/notify.service
systemctl enable notify

echo "starting..." >&2
systemctl restart notify
