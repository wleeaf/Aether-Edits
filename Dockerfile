# syntax=docker/dockerfile:1.7

# Build stage: compile the Vite project. node:22-alpine is enough for tsc + vite.
FROM node:22-alpine AS builder
WORKDIR /app

# Install deps using the lockfile so the build is reproducible.
COPY package.json package-lock.json ./
RUN npm ci

# Build. Vite emits /app/dist with hashed asset filenames.
COPY . .
RUN npm run build

# Serve stage: nginx serves the static dist/. The outer Caddy in
# /opt/wleeaf adds COOP/COEP/CORP headers — keep this image dumb.
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
