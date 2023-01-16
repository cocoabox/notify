FROM ubuntu:focal AS build
RUN apt update && \
 DEBIAN_FRONTEND=noninteractive apt -y install wget unzip tar && \
 mkdir -p /voicevox_engine && \
 wget https://github.com/VOICEVOX/voicevox_core/releases/download/0.11.4/core.zip && \
 unzip core.zip && \
 mv core /voicevox_engine && \
 wget https://github.com/VOICEVOX/onnxruntime-builder/releases/download/1.10.0.1/onnxruntime-linux-arm64-cpu-v1.10.0.tgz && \
 tar xzvf onnxruntime-linux-arm64-cpu-v1.10.0.tgz && \
 mv onnxruntime-linux-arm64-cpu-v1.10.0 /voicevox_engine

FROM ubuntu:focal
RUN apt update && \
 DEBIAN_FRONTEND=noninteractive apt -y install git pip python3 python3-dev python3-wheel cmake g++ libsndfile1 && \
 git clone -b 0.11.4 https://github.com/VOICEVOX/voicevox_engine.git && \
 cd voicevox_engine/ && \
 pip install -r requirements.txt -r requirements-test.txt
COPY --from=build /voicevox_engine /voicevox_engine
ENV VV_CPU_NUM_THREADS=4

RUN python3 -c "import pyopenjtalk; pyopenjtalk._lazy_init()"

CMD ["python3","/voicevox_engine/run.py","--voicelib_dir","/voicevox_engine/core","--runtime_dir","/voicevox_engine/onnxruntime-linux-arm64-cpu-v1.10.0/lib","--host","0.0.0.0", "--cpu_num_threads", "4"]
