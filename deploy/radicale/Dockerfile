FROM python:3.13-alpine
RUN pip install --no-cache-dir 'Radicale==3.8.0' 'bcrypt==5.0.0' \
    && addgroup -S radicale && adduser -S -G radicale radicale \
    && mkdir /data && chown radicale:radicale /data
COPY config /etc/radicale/config
COPY start.py /app/start.py
USER radicale
EXPOSE 5232
CMD ["python", "/app/start.py"]
