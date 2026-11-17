# Fixture image only. The Python base and PDF binaries match Quantself #447.
FROM oven/bun:1.3.14 AS bun
FROM python@sha256:05a994d2344eb364cc186910f4fc8786a38215f39f00d0acc25bff33a08f4177
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg procps poppler-utils=25.03.0-5+deb13u4 libgl1=1.7.0-1+b2 \
      tesseract-ocr=5.5.0-1+b1 tesseract-ocr-eng=1:4.1.0-2 \
      tesseract-ocr-deu=1:4.1.0-2 tesseract-ocr-script-latn \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY whisper-sidecar/requirements.txt /tmp/whisper-requirements.txt
RUN pip install --no-cache-dir --only-binary=:all: -r /tmp/whisper-requirements.txt \
      ctranslate2==4.8.1 av==16.0.1 PyMuPDF==1.27.2.3 pypdf==7.1.0 \
      paddlepaddle==3.3.1 paddleocr==3.7.0 paddlex==3.7.2 spacy==3.8.18 phonenumbers==9.0.43

# Stage and hash-check these public wheels before building, then mount them only during this layer.
RUN --mount=type=bind,from=name_wheels,target=/wheels,ro \
    cd /wheels && \
    printf '%s\n' \
      '1932429db727d4bff3deed6b34cfc05df17794f4a52eeb26cf8928f7c1a0fb85  en_core_web_sm-3.8.0-py3-none-any.whl' \
      'fec69fec52b1780f2d269d5af7582a5e28028738bd3190532459aeb473bfa3e7  de_core_news_sm-3.8.0-py3-none-any.whl' \
      | sha256sum -c - && \
    pip install --no-cache-dir --no-deps --no-index /wheels/*-3.8.0-py3-none-any.whl

COPY src ./src
COPY tests/helpers.ts ./tests/helpers.ts
COPY whisper-sidecar/app.py whisper-sidecar/media_normalization.py ./whisper-sidecar/
COPY scripts/prove-aggregate-queue.ts ./scripts/
COPY scripts/aggregate-proof/run-budget.sh scripts/aggregate-proof/rss.ts ./scripts/aggregate-proof/
ENTRYPOINT ["sh", "/app/scripts/aggregate-proof/run-budget.sh"]
