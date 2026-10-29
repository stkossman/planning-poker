# Planning Poker

A local Planning Poker app for creating sessions and joining with separate facilitator and participant access.

## Requirements

Node.js 22.13+ (22.x) or 24.x LTS and Bun 1.3.5+.
The API uses Node's built-in experimental SQLite module.

## Installation

```sh
bun install --frozen-lockfile
bun run build
```

## Development

```sh
bun run dev
```

Open http://localhost:5173. SQLite is stored in `data/`.
Optional API settings: `PORT`, `HOST`, `DATABASE_PATH`, `WEB_ORIGIN`.
Vite accepts `API_ORIGIN` for its local proxy.

## Build and test

```sh
bun run typecheck
bun run test
bun run build
bun run start
```

`bun run start` serves the built app at http://localhost:3001.
Set `WEB_ORIGIN` to that origin when using the built app.
Set `NODE_ENV=production` behind HTTPS to enable secure cookies.
