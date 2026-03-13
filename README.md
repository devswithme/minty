## dc_bot

Bun + Hono API + Discord bot for handling course submissions (via Tally), creating Discord forum threads for mentor review, and issuing/verifying completion certificates.

### What runs

- **API**: HTTP server on `PORT` (default **3000**) via `src/server.ts`
- **Bot**: Discord gateway client via `src/bot/discordBot.ts`
- **DB**: Postgres via Prisma (`prisma/schema.prisma`)

### Setup (local)

```sh
bun install
cp .env.example .env
# fill .env values
bunx prisma generate
```

Run:

```sh
# API (hot reload)
bun run api

# Bot
bun run bot

# Both
bun run dev
```

Open `http://localhost:3000`.

### Setup (Docker / production-ish)

```sh
cp .env.example .env
# fill .env values
docker compose up -d --build
```

### Request flow (short)

- **Student** hits `GET /submit?course_id=...` → signs in with Discord → redirected to a prefilled Tally form.
- **Tally** calls `POST /webhook/tally` → API verifies `TALLY_SIGNING_SECRET`, stores the submission, creates a Discord forum thread.
- **Mentor** reviews inside the thread using `/ev` → bot stores evaluation and (on PASS) DMs a generated certificate image.
- **Anyone** can verify a certificate via `GET /v/:certificateId` (JSON response).

### Key endpoints

- **`GET /submit`**: start/continue the submission flow (redirects)
- **`POST /webhook/tally`**: Tally webhook (HMAC signature required)
- **`GET /v/:certificateId`**: certificate verification
- **`/api/auth/*`**: Better Auth routes (Discord OAuth)

### Notes

- **Tally signature**: set `TALLY_SIGNING_SECRET` (defaults to `tally.abc` if unset; change in prod).
- **Internal mentor API**: routes under `/api/mentor/*` require header `x-internal-token` matching `DISCORD_INTERNAL_TOKEN`.
