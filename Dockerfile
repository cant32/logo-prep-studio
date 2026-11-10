# Railway (or any Docker host) runs the small Node server in server/: it hands
# out the app's files and runs the website logo search. The app itself runs in
# each person's browser and never sends client logos here.
FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production
USER node
CMD ["node", "server/server.js"]
