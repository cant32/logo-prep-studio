# Railway (or any Docker host) runs the small Node server in server/: it hands
# out the app's files and runs the website logo search. The app itself runs in
# each person's browser and never sends client logos here.
FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production
# starts as root only to hand the /data volume (team counter) to the "node"
# user; server/server.js drops to "node" before serving anything
CMD ["node", "server/server.js"]
