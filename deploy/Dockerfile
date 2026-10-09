# Build from the repository root:  docker build -f deploy/Dockerfile -t tvads .
FROM node:22-alpine
WORKDIR /app
COPY tv-ad-backend/package.json tv-ad-backend/package-lock.json tv-ad-backend/
RUN cd tv-ad-backend && npm ci --omit=dev
COPY tv-ad-backend/src tv-ad-backend/src
COPY tv-ad-backend/public tv-ad-backend/public
COPY tv-ad-backend/scripts tv-ad-backend/scripts
COPY web-core web-core
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATA_DIR=/data
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
WORKDIR /app/tv-ad-backend
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
