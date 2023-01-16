# notify

notify is a self-contained MQTT notification manager. it is designed to run on macos or raspberry pi with a speaker to output text-to-speech alerts. it uses minimal external APIs and fails gracefully in case access to these API is restricted. in addition, 

- FIFO queue with priority exceptions
- rate limiting
- nagging (repeated notifications) with the following options :
    - at desired frequency, until a certain date
    - at desired frequency, for a certain period of time
    - at desired frequency, for specific number of nags
- priority
	 - useful for spoken alert where it might take 10~20 seconds for each alert to be spoken
    - urgent spoken-notifications can interrupt currently-running ones
    - important notifications can overtake existing pending items
- muting and resuming of all notifications
- plugin-based notification emitters (see below for instructions on how to configure them)
	* text-to-speech on macOS and linux
	* locally or remotely hosted [voicevox](https://voicevox.hiroshiba.jp)
	* twitter
	* LINE Notify
	* Email
- dedupe using message-specific unique-ids (`uniqid`s)

## Configuring MQTT broker

create directory `conf/` ; you might want to copy files from `conf-sample/*` to `conf/`

create `conf/mqtt-notify.json5` . the following example shows fields that you should provide for an MQTTS(TLS) connection.

```
{
    broker: {
        host: 'cocoa-mqtt',
        port: 8883,
        username: 'USERNAME',
        password: 'PASSWORD',
    },
    client_cert: '@file:RELATIVE_PATH_TO_CONF_DIR',
    client_key: '@file:RELATIVE_PATH_TO_CONF_DIR',
    ca: '@file:RELATIVE_PATH_TO_CONF_DIR',
    topic_prefix: 'notify/',
}
```
for `client_cert`,`client_key` and `ca`, the value may be the string body of the corresponding PEM file, or it may be `@file:PEM_FILE_PATH` where the file path should be relative to `conf/` : for example if you have `conf/certs/ca.pem` then the value of `ca` should be `@file:certs/ca.pem`. 

## Configuring Notification Plugins

### Gmail

1. create an [app password](https://support.google.com/mail/answer/185833?hl=en) for your gmail account

2. insert the following snippet into `conf/plugins.json5`

	```
	{
			:
			:
	    mailto: {
	        service: 'Gmail',
	        user: 'YOUR_EMAIL_ADDRESS',
	        password: 'YOUR_APP_PASSWORD',
	        mailto: [
	            'RECIPIENT_EMAIL_ADDRESS',
	        ],
	    },
	}
	```
	alternatively, for other email servers, instead of setting the `service` key, set `host` and `port`.
	
### Twitter

1. create `conf/twitter-app.json5` with the following body. you'll need your own consumer key and consumer secrets, or you may steal one from [here](https://gist.github.com/uhfx/3922268).

   ```
   { consumer_key: 'xxx', consumer_secret: 'xxx' }
   ```
   
2. run `tools/twitter-authenticate.js`, log onto Twitter as instructed then enter PIN

3. confirm `conf/twitter-conf.json5` is created

4. insert the following snippet into `conf/plugins.json5`

	```
	{
			:
			:
		twitter: {
		    app: '@file:twitter-app.json5',
		    oauth: '@file:twitter-oauth.json5',
		    mention: 'ENTER_YOUR_TWITTER_ID_HERE', // do not prepend "@"
		},
	}
	```
   

### LINE

1. go to [LINE notify](https://notify-bot.line.me/ja/). Scan the QR code to add the LINE Notify bot to your friend list
2. create a new ROOM and invite the LINE Notify bot to the room
3. go to [Connected Service](https://notify-bot.line.me/my/) and generate a new token
4. insert the following snippet containing the token into `conf/plugins.json5`

	```
	{
			:
			:
	    line: {
	        // generate a token at : https://notify-bot.line.me/my/
	        token: 'INSERT_TOKEN_HERE',
	    },		
	}
	```

### Speak (macOS/linux text-to-speech)

1. for MacOS, no software installation is necessary. You might want to [download more voices](https://support.apple.com/ja-jp/guide/mac-help/mchlp2290/mac) to your computer.

2. paste the following snippet into `conf/plugins.json5`
 
	```
		{	
			:
			:
	    speak: {
	        cache_dir: '/tmp',          // or dir on non-SD-card partition
	        plugins: {
	            say: {
	                default_voice: {
	                    ja: 'Kyoko',    // <-- change the preferred voice for each language, unfortunately
	                    en: 'Ava',      //     Siri voices cannot be used
	                },
	            },
	            AquesTalkPi: {
	                app_path: '/opt/aquestalkpi/AquesTalkPi',  // (*1)
	            },
                 voicevox_client: {
                    // install on a Raspi 4B (see ../tools/voicevox-docker-raspi/* )
                    host: 'my-voicevox-server:50021',
                    speaker: 1,
               },	            
	        },
	        preferred_languages: [ 
	            'en', 'ja', 'fr',       // <-- languages that messages will show up in
	        ]
	    }
	```

For raspberry pi, install [AquesTalkPi](https://www.a-quest.com/products/aquestalkpi.html). 

#### Voicevox

Voicevox provides very realistic Japanese text-to-speech. To install Voicevox on another computer (a Pi4B is OK but slow (0.6sec per character); a PC with GPU is better), provide the "voicevox_client" configuration object as shown above, replacing your voicevox engine host/port. 

To host your own voicevox instance on a faster computer or a raspi, see [tools/voicevox-docker-raspi](tools/voicevox-docker-raspi)/*.

### Message uniqids

Ideally, each message should have its own uniqid, for example `cocoa.home-automation.curtains.opened#curtain1`. The uniqid is required when you need to stop/acknowledge nagging.

## MQTT Command Topics

- `notify/do/notify`
    enqueues one notification. payload may be either one of the followings:
    - Message Payload STRING : 
    
      ```
      MESSAGE_STR #TAG1 #TAG2 ...
      ```
      
    - Message Payload JSON :
    
      ```
      {
        message: STRING,           # message without tags
        tags: [TAG1, TAG2, ...],   # without hash sign
        uniqid: STRING,            
            # a unique ID representing this message, this is required for 
            # repeated nags and used to acknowledge a nag
        urgency: BOOLEAN | NUMBER, 
            # true : urgent message, this message will interupt any
            #        currently-running ones,
            # NUMBER : high priority message that should overtake any 
            #        currently-running messages by N items (N being the 
            #        value of urgency)
            # false (or field-not-provided) : low-priority ; appends
            #        to the end of the current running queue 
        for: PERIOD,                
            # nag for a specific period of time, mustn't coexist with "until" and "times"
            # requires "frequency"
        until: DATE_STRING_OR_MSEC_TIMESTAMP,
            # nag until specific time, mustn't coexist with "for" and "times"
            # requires "frequency"
        times: NUMBER
            # perform N nags total, mustn't coexist with "for" and "until"
            # requires "frequency"
        frequency: PERIOD,           # how often should we nag
        once_period: PERIOD,         # rate limit period
      }
      ```
	   
      PERIOD is one of the followings:
      - `NUMBER` : a period of N minutes
      - `STRING` in format `"NUMBER (minutes|hours|days)"` 
      - `[NUMBER, "(minutes|hours|days)"] array  
        
      TAG is any optional metadata that should be associated with each notification. 
      The following TAG strings are recognised by notify:
      - `critical` : colourises/prepends a critical sound the the message
      - `warn` : colourises/prepends a critical sound the the message
      - `plugin:PLUGIN_NAME,PLUGIN_NAME,...` : only allow specified plugins to handle the notification

- `notify/do/mute`

    begins muting. repeated nags during mute will be discarded. Message body should be empty.

- `notify/do/unmute`

    ends muting. Message body should be empty.

- `notify/do/acknowledege`

    stops nagging of one repeated message. payload: 
    ```
    UNIQID_STR
    ```
    
- `notify/do/query_messages`

    get current execution queue and a list of repeated nags; response will be posted to
    topic `notify/messages`

- `notify/do/suspend`

   stop sending notifications. New notifications will be queued up. Message body should be empty.
   
- `notify/do/resume`

   resume sending notifications. Queued notifications will be sent in one go. Message body should be empty.

