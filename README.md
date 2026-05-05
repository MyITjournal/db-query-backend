## HNG14 Stage 3 Task

### Intelligence Query Engine (backend)

This is a continuation of the db-query-engine started in Stage 2. It is a REST API that serves a pre-seeded database of name profiles with GitHub OAuth authentication, role-based access control, natural language search, CSV export, and JWT token rotation.

- **GitHub Repository:** `https://github.com/MyITjournal/db-query-backend`
- **Live API Base URL:** `https://db-query-backend-myitjournal8137-tp61obq3.leapcell.dev`

---

### Tech Stack

| Layer         | Technology                                                         |
| ------------- | ------------------------------------------------------------------ |
| Runtime       | Node.js v22+ (ESM — `"type": "module"`)                            |
| Framework     | Express 5                                                          |
| Database      | PostgreSQL via `pg` (raw SQL) + Sequelize (table sync + seed only) |
| Auth          | GitHub OAuth 2.0, `jsonwebtoken` (access + refresh tokens)         |
| Rate limiting | `express-rate-limit` — 10 req / 15 min on all `/auth/*` routes     |
| Validation    | `express-validator`                                                |
| Country data  | `countries-list` (ISO 3166-1 alpha-2 lookups for NLQ)              |
| Profile data  | `axios` → genderize.io / agify.io / nationalize.io                 |
| IDs           | `uuid` v7                                                          |

---

### Project Structure

```
├── index.js                        ← local dev entry point
├── server.js                       ← host/Vercel entry point
├── eslint.config.js                ← ESLint v10 flat config
├── tests/
│   └── helpers.test.js             ← Node built-in test runner
└── src/
    ├── app.js                      ← Express setup, route mounting, 404 handler
    ├── config/
    │   └── index.js                ← centralised env variable loading
    ├── db/
    │   ├── index.js                ← pg connection pool
    │   ├── sequelize.js            ← Sequelize models + connectDB (sync + seed)
    │   ├── seed.js                 ← bulk-inserts seed_profiles.json
    │   └── seed_profiles.json      ← 2026 pre-generated profiles
    ├── helpers/
    │   ├── helperFunctions.js      ← determineAgeGroup, constructLinks, formatProfile, getCountryName, handleUpstreamError
    │   ├── nlq.js                  ← natural language query parser
    │   ├── tokens.js               ← signTokens, verifyAccessToken, verifyRefreshToken
    │   └── validators.js           ← express-validator rule sets
    ├── middleware/
    │   ├── authenticate.js         ← Bearer JWT validation → req.user
    │   ├── authorize.js            ← role-based access control factory
    │   └── apiVersion.js           ← enforces X-API-Version: 1 header
    └── routes/
        ├── auth.js                 ← GitHub OAuth, PKCE token exchange, refresh, logout
        ├── profiles.js             ← GET /api/profiles, /search, /export
        ├── createProfile.js        ← createProfileHandler, getProfileByIdHandler
        └── deleteProfile.js        ← deleteProfileHandler
```

---

## Authentication

All profile and user endpoints require a valid Bearer access token.

### Web flow (browser)

1. Redirect user to `GET /auth/github`
2. GitHub redirects back to `GET /auth/github/callback`
3. Response includes `access_token` (3 min) and `refresh_token` (5 min)

### Token rotation

- `POST /auth/refresh` — exchanges a valid refresh token for a new pair; old token is atomically invalidated
- `POST /auth/logout` — deletes the refresh token from the DB server-side

---

## Roles

| Role      | Assigned         | Permissions                               |
| --------- | ---------------- | ----------------------------------------- |
| `analyst` | default on login | read profiles, search, export CSV         |
| `admin`   | manually set     | all analyst permissions + create profiles |

Role is embedded in the access token and re-verified from the DB on every authenticated request.

---

## Rate Limiting

| Scope               | Limit                         |
| ------------------- | ----------------------------- |
| `/auth/*` routes    | 10 requests / minute per IP   |
| All other endpoints | 60 requests / minute per user |

Exceeding either limit returns `429 Too Many Requests`:

```json
{ "status": "error", "message": "Too many requests, please try again later" }
```

Standard `RateLimit` headers (draft-8) are included in every response.

---

## Endpoints Reference

### Health check

#### `GET /`

```json
{ "status": "OK", "message": "Name Classification API is running" }
```

---

### Auth

#### `GET /auth/github`

Redirects to GitHub OAuth. No body required.

#### `GET /auth/github/callback`

GitHub redirects here after user authorises. Returns tokens.

```json
{ "status": "success", "access_token": "...", "refresh_token": "..." }
```

#### `POST /auth/token`

Exchanges a GitHub OAuth `code` for tokens. Accepts an optional `code_verifier` for PKCE flows.

| Body field      | Required |
| --------------- | -------- |
| `code`          | Yes      |
| `code_verifier` | No       |

```json
{
  "status": "success",
  "access_token": "...",
  "refresh_token": "...",
  "username": "MyITjournal"
}
```

#### `POST /auth/refresh`

| Body field      | Required |
| --------------- | -------- |
| `refresh_token` | Yes      |

```json
{ "status": "success", "access_token": "...", "refresh_token": "..." }
```

#### `POST /auth/logout`

| Body field      | Required |
| --------------- | -------- |
| `refresh_token` | Yes      |

```json
{ "status": "success", "message": "Logged out" }
```

---

### Users

#### `GET /api/users/me`

Requires: `Authorization: Bearer <token>`

```json
{
  "status": "success",
  "data": {
    "id": "019600e7-...",
    "username": "MyITjournal",
    "email": "user@example.com",
    "avatar_url": "https://avatars.githubusercontent.com/...",
    "role": "admin"
  }
}
```

---

### Profiles

All profile endpoints require:

- `Authorization: Bearer <token>`
- `X-API-Version: 1`

#### `GET /api/profiles`

**Query Parameters (all optional)**

| Parameter                 | Type   | Constraints                               |
| ------------------------- | ------ | ----------------------------------------- |
| `gender`                  | string | `male` or `female`                        |
| `age_group`               | string | `child`, `teenager`, `adult`, `senior`    |
| `country_id`              | string | ISO alpha-2 code (e.g. `NG`, `US`)        |
| `min_age`                 | int    | 0–150                                     |
| `max_age`                 | int    | 0–150                                     |
| `min_gender_probability`  | float  | 0–1                                       |
| `min_country_probability` | float  | 0–1                                       |
| `sort_by`                 | string | `age`, `created_at`, `gender_probability` |
| `order`                   | string | `asc` or `desc` (default: `desc`)         |
| `page`                    | int    | ≥ 1 (default: `1`)                        |
| `limit`                   | int    | 1–50 (default: `10`)                      |

**Success Response** — `200 OK`

```json
{
  "status": "success",
  "page": 1,
  "limit": 10,
  "total": 412,
  "total_pages": 42,
  "links": {
    "self": "...",
    "next": "...",
    "prev": null,
    "first": "...",
    "last": "..."
  },
  "data": [
    {
      "id": "019600e7-...",
      "name": "ella",
      "gender": "female",
      "gender_probability": 0.99,
      "age": 46,
      "age_group": "adult",
      "country_id": "NG",
      "country_name": "Nigeria",
      "country_probability": 0.85,
      "created_at": "2026-04-01T12:00:00.000Z"
    }
  ]
}
```

---

#### `GET /api/profiles/search`

**Query Parameters**

| Parameter | Type   | Required | Constraints           |
| --------- | ------ | -------- | --------------------- |
| `q`       | string | Yes      | max 500 characters    |
| `page`    | int    | No       | ≥ 1 (default: `1`)    |
| `limit`   | int    | No       | 1–100 (default: `10`) |

**Example Requests**

```
GET /api/profiles/search?q=women over 30 from nigeria
GET /api/profiles/search?q=adult males from the US
GET /api/profiles/search?q=men in their 40s from germany
```

**Success Response** — `200 OK`

```json
{
  "status": "success",
  "query": "women over 30 from nigeria",
  "parsed": { "gender": "female", "min_age": 30, "country_id": "NG" },
  "page": 1,
  "limit": 10,
  "total": 27,
  "total_pages": 3,
  "links": { "self": "...", "next": "...", "prev": null, "first": "...", "last": "..." },
  "data": [ { ...profile } ]
}
```

---

#### `POST /api/profiles` — admin only

| Body field | Required |
| ---------- | -------- |
| `name`     | Yes      |

Calls genderize.io, agify.io, and nationalize.io in parallel to build the profile. Idempotent — returns the existing profile if the name already exists.

**Success Response** — `201 Created` (or `200 OK` if already exists)

```json
{ "status": "success", "data": { ...profile } }
```

---

#### `GET /api/profiles/export` — admin + analyst

Returns all matching profiles as a CSV download. Supports the same filter parameters as `GET /api/profiles`.

Response headers:

```
Content-Type: text/csv
Content-Disposition: attachment; filename="profiles_<timestamp>.csv"
```

---

## Profile Fields

| Field                 | Type   | Description                                                         |
| --------------------- | ------ | ------------------------------------------------------------------- |
| `id`                  | string | UUID v7                                                             |
| `name`                | string | Profile name                                                        |
| `gender`              | string | `male` or `female`                                                  |
| `gender_probability`  | number | Confidence score (0–1)                                              |
| `age`                 | number | Estimated age                                                       |
| `age_group`           | string | `child` (0–12), `teenager` (13–19), `adult` (20–59), `senior` (60+) |
| `country_id`          | string | ISO 3166-1 alpha-2 country code                                     |
| `country_name`        | string | Full country name                                                   |
| `country_probability` | number | Country confidence score (0–1), rounded to 2 d.p.                   |
| `created_at`          | string | UTC ISO 8601 timestamp                                              |

---

## Error Responses

All errors follow the same structure:

```json
{ "status": "error", "message": "<description>" }
```

| Status | Condition                                                       |
| ------ | --------------------------------------------------------------- |
| `400`  | Missing or empty required parameter / bad request               |
| `401`  | Missing, invalid, or expired access token                       |
| `403`  | Insufficient role permissions or inactive account               |
| `404`  | Profile not found / route not found                             |
| `422`  | Parameter present but fails type/value validation               |
| `429`  | Rate limit exceeded (auth routes)                               |
| `500`  | Internal server error                                           |
| `502`  | Upstream API failure (genderize / agify / nationalize / GitHub) |

---

## Running Locally

```bash
# 1. Clone the repository
git clone https://github.com/MyITjournal/db-query-backend.git
cd db-query-backend

# 2. Install dependencies
npm install

# 3. Configure environment variables
```

Create a `.env` file in the project root:

```env
DATABASE_URL=postgresql://postgres:your_password@localhost:5432/your_db_name
DATABASE_SSL=false

GITHUB_CLIENT_ID=your_github_oauth_app_client_id
GITHUB_CLIENT_SECRET=your_github_oauth_app_client_secret
GITHUB_CALLBACK_URL=http://localhost:3000/auth/github/callback

JWT_ACCESS_SECRET=some_long_random_secret_32_plus_chars
JWT_REFRESH_SECRET=another_long_random_secret_32_plus_chars
```

> Create a GitHub OAuth App at **Settings → Developer settings → OAuth Apps**. Set the callback URL to match `GITHUB_CALLBACK_URL`.

```bash
# 4. Start the server
node index.js
```

The server starts on port `3000`. On first startup, Sequelize creates all tables if they don't exist and seeds `db_profiles` with 2026 profiles. Subsequent startups skip seeding if data already exists.

---

## Scripts

```bash
npm start       # node index.js
npm run lint    # eslint src/ index.js server.js
npm test        # node --test tests/**/*.test.js
```
