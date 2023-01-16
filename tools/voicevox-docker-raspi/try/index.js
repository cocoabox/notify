#!/usr/bin/env node

// 
// for amd64 , use : docker run  --platform "linux/amd64" --rm -it -p '127.0.0.1:50021:50021' hiroshiba/voicevox_engine:cpu-ubuntu20.04-latest
//

const axios = require('axios');
const QueryString = require('querystring');
const fs = require('fs');

(async () => {
    async function voicevox(text, {speaker, host}={}) {
        if (! speaker) speaker = 1;
        if (! host) host = 'localhost:50021';

        const q = QueryString.stringify({ speaker, text });
        const response = await axios.post(`http://${host}/audio_query?${q}`);
        const speech_data = response?.data;
        const response2 = await axios.request({
            method:'post',
            url: `http://${host}/synthesis?speaker=${speaker}`, 
            data: JSON.stringify(speech_data),
            headers: {
                'Content-type': 'application/json',
            },
            responseType: 'arraybuffer'
        });
        return response2?.data; 
    }

    buffer = await voicevox('これはテストです。おはようございます');

    const outputFilename = 'output.wav';
    fs.writeFileSync(outputFilename, buffer);

})();


