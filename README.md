# Extra API

The Fastify and ConnectRPC backend for Extra. PostgreSQL stores expenses, categories, and sessions. The API contract lives in `proto/extra/v1/expense.proto`.

## Local setup

Requires Node.js 24 and PostgreSQL 16 or newer. If Docker is available, `docker compose up -d db` starts a local PostgreSQL 17 instance. Copy `.env.example` to `.env`, then run:

```sh
pnpm install
pnpm proto:generate
pnpm db:migrate
pnpm user:create email@example.com
pnpm dev
```

`user:create` prompts for the password without echoing it. The frontend runs at `http://localhost:3000` and the API at `http://localhost:3101` by default.

## API

ConnectRPC supports binary Protobuf and JSON. The canonical contract is the `.proto` file. For a manual JSON request that demonstrates the protected endpoint (it returns HTTP 401 until login):

```sh
curl -i -H 'Content-Type: application/json' -d '{}' http://localhost:3101/extra.v1.ExpenseService/ListCategories
```

All expense methods require a session established with `AuthService/Login`. Session tokens are stored only in an HttpOnly cookie; their hashes are stored in PostgreSQL. The login endpoint is rate limited. The API never exposes a shared bearer token to the browser.

## Checks

```sh
pnpm proto:lint
pnpm typecheck
pnpm test
```

The tests run the actual migration in an isolated in-memory PostgreSQL instance (PGlite), so they do not need Docker or a production database.
