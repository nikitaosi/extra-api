# Extra API

The Fastify and ConnectRPC backend for Extra. PostgreSQL stores expenses, categories, and sessions. The API contract lives in `proto/extra/v1/expense.proto`.

## Local setup

Requires Node.js 24 and PostgreSQL 16 or newer. Choose one local database setup:

- Docker: `docker compose up -d db` starts PostgreSQL 17. The database URL in `.env.example` works with this setup.
- [Postgres.app](https://postgresapp.com/): initialize and start a PostgreSQL 17 cluster, then create a project database with `/Applications/Postgres.app/Contents/Versions/17/bin/createdb extra`. In `.env`, set `DATABASE_URL=postgres://YOUR_MAC_USERNAME@127.0.0.1:5432/extra` after copying the example below. Postgres.app does not require changing the system `PATH` when using the full CLI path.

Then run:

```sh
cp .env.example .env
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

The production frontend sends same-origin requests to `/api/*`, which Netlify rewrites to this API. For POST requests carrying the session cookie, the API requires an `Origin` exactly matching `FRONTEND_ORIGIN`; absent, `null`, or other origins receive HTTP 403. The cookie remains `SameSite=Lax` and is `Secure` in production. A script replaying a session cookie must also send the configured `Origin` header. This check limits browser cross-site request forgery, but it is not authentication and does not stop scripts that can set headers or JavaScript running on the trusted frontend origin.

Login permits five attempts per minute per Fastify client IP, including requests with query parameters. The limiter uses in-memory state, so it is not shared between multiple server instances; behind a proxy, multiple users may also share a reported IP. Unknown emails still perform an Argon2 verification against a dummy hash to reduce account enumeration by response time, although database and network variation cannot be made identical.

Expense amounts use integer minor units. New records support THB and USD; the earlier GEL enum and database values remain accepted so existing records can still be read and updated. Currency support is defined in the Protobuf contract and enforced by the API and database migration together.

## Checks

```sh
pnpm proto:lint
pnpm typecheck
pnpm test
```

The tests run the actual migration in an isolated in-memory PostgreSQL instance (PGlite), so they do not need Docker or a production database.
GitHub Actions also runs these checks, verifies that generated Protobuf code is committed, and applies migrations to a fresh PostgreSQL 17 service.

## Hosting

`render.yaml` defines a free Render web service. Set `DATABASE_URL` to the Neon PostgreSQL connection string and `FRONTEND_ORIGIN` to the exact HTTPS Netlify site origin in Render's environment settings. These values must not be committed. The hosted start command applies pending migrations before accepting requests; `/health` checks the database connection. Create the first user from a trusted local machine with `DATABASE_URL` pointing to Neon and `pnpm user:create email@example.com`.
