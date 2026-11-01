# MFA release, revision 4: the base image is pinned by digest — the exact python:3.12-slim image the
# reviewed stage 1 build pulled (Cloud Build 79ce1bc9, 27 Oct 2026). The tag alone re-resolves on every
# build (3.12.15 on 22 Oct, 3.12.16 on 26 Oct), so the same source produced different images.
FROM python:3.12-slim@sha256:12316debbfb86890f6b2d825820612741ba527ad5a44e3902759141d572bfe8f

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt requirements.lock ./
# Exactly the reviewed set: every package pinned, nothing resolved at build time, and the
# build fails if the set is inconsistent.
RUN pip install --no-cache-dir --no-deps -r requirements.lock && pip check

COPY app ./app
COPY scripts ./scripts

# Cloud Run provides PORT. Default matches local development.
ENV PORT=8080
EXPOSE 8080

CMD exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 2
