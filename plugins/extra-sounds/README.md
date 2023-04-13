to insert extra sounds :

1. copy sound file to this directory
2. modify conf/plugins.json5:

    ```json5
    {
      speak: {
        extra_sounds: {
          # HASHTAG_NAME: SOUND_FILENAME,
          '#chime': 'my-chime.wav'
        }
      }
    }
    ```
3. to use your custom sound, submit a notify message:
    - topic : `notify/do/notify`
    - message: `Your message here  #chime  #plugins:speak`
