FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r /app/requirements.txt

# Offline speech models (Hindi ~80 MB, Indian English ~55 MB) for browsers without built-in speech recognition.
RUN python -c "import urllib.request, zipfile, io; [zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(f'https://alphacephei.com/vosk/models/{m}.zip').read())).extractall('/app/models') for m in ('vosk-model-small-hi-0.22', 'vosk-model-small-en-in-0.4')]"

COPY app /app/app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
