# Freaky Tiki - one container = the whole game (page + art + server).
# Works on Fly.io, Render (Docker), Railway, any VPS:  docker build -t freaky-tiki .
#                                                       docker run -p 8000:8000 freaky-tiki
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY assets/ assets/
COPY client/ client/
COPY game/ game/
COPY server/ server/
WORKDIR /app/server
# $PORT is set by most hosts; falls back to 8000 locally.
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-8000}"]
