# Daily encrypted Postgres dump (see backup.sh). pg_dump matches the server's version.
FROM postgres:16-alpine
RUN apk add --no-cache age rclone
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
ENV RCLONE_CONFIG=/config/rclone/rclone.conf
CMD ["backup.sh", "loop"]
