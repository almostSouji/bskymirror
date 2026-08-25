FROM node:24-alpine AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /usr/bskymirror
COPY . .

RUN npm --global install corepack@latest
RUN corepack enable
RUN corepack install

RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm build

CMD pnpm start
