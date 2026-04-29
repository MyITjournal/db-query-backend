## HNG14 Stage 2 Task

### Introduction

#### Intelligence Query Engine Assessment

This is a read-only REST API that serves a pre-seeded database of name profiles. Each profile contains predicted gender, age, and nationality data. The API supports filtering, sorting, pagination, and a natural language query interface for the profiles endpoint.

- **GitHub Repository:** `https://github.com/MyITjournal/db-query-engine`
- **Live API Base URL:** `https://db-query-engine-myitjournal8137-upfultli.leapcell.dev`

---

### Tech Stack

| Layer        | Technology                                                                |
| ------------ | ------------------------------------------------------------------------- |
| Runtime      | Node.js (ESM — `"type": "module"`)                                        |
| Framework    | Express                                                                   |
| Database     | PostgreSQL via `pg` (raw SQL queries) + Sequelize (table management only) |
| Validation   | `express-validator`                                                       |
| Country data | `countries-list` (ISO 3166-1 alpha-2 lookups)                             |

> All packages (Express, pg, Sequelize, axios, express-validator, countries-list, uuidv7) are installed via `npm install`.

---

## Project Structure

```
├── index.js                       ← local dev entry point
├── server.js                      ← Host entry point
└── src/
    ├── app.js                     ← Express setup, CORS header, route mounting, 404 handler
    ├── config/
    │   └── index.js               ← environment variable loading
    ├── db/
    │   ├── index.js               ← pg connection pool (used for all queries)
    │   ├── sequelize.js           ← Sequelize model + connectDB (sync + seed on startup)
    │   ├── seed.js                ← bulk-inserts seed_profiles.json into db_profiles
    │   └── seed_profiles.json     ← 2026 pre-generated profiles
    └── helpers/
    │   ├── helperFunctions.js     ← determineAgeGroup, formatProfile, handleUpstreamError
    │   ├── nlq.js                 ← natural language query parser
    │   └── validators.js          ← express-validator rule sets + handleValidationErrors
    └── routes/
        └── profiles.js            ← GET /api/profiles, GET /api/profiles/search
```

---

## How It Works

### 1. Startup (`connectDB`)

`src/db/sequelize.js` exports a `connectDB` function that runs every time the server starts:

1. **Authenticate** — verifies the PostgreSQL connection.
2. **`sync({ force: true })`** — drops and recreates the `db_profiles` table using the Sequelize model definition. This ensures the schema is always fresh.
3. **Seed** — calls `seedProfiles()`, which bulk-inserts all 2026 records from `seed_profiles.json`. Since the table is always recreated, there is no stale data.

> Raw SQL queries (via `pg` pool) are used for all API requests. Sequelize is only used for table management at startup.

---

### 2. `GET /api/profiles` — Filter and List

Defined in `src/routes/profiles.js`.

#### Validation

`profilesListRules` (in `validators.js`) validates each optional query parameter before the handler runs. A missing or empty parameter causes an immediate `400 "Missing or empty parameter"` response; a present but wrongly-typed parameter causes `402 "Invalid parameter type"`.

#### SQL query construction

The handler builds a parameterized WHERE clause dynamically:

```
filter param          →  SQL condition
──────────────────────────────────────────────────────
gender                →  LOWER(gender) = $n
age_group             →  age_group = $n
country_id            →  country_id = $n
min_age               →  age >= $n
max_age               →  age <= $n
min_gender_probability →  gender_probability >= $n
min_country_probability →  country_probability >= $n
```

Values are pushed to an array and referenced by the position (`$1`, `$2`, …)

#### Pagination

`page` and `limit` (default `1` / `10`, max `50`) are applied as `LIMIT` / `OFFSET`. The response includes `total` (the total number of matching rows counted before pagination).

#### Response

```json
{
  "status": "success",
  "page": 1,
  "limit": 10,
  "total": 412,
  "data": [ { ...profile }, ... ]
}
```

---

### 3. `GET /api/profiles/search` — Natural Language Query

This endpoint is also defined in `profiles.js`, and it accepts a plain English sentence in the `q` parameter and translates it into database filters.

#### Parsing (`src/helpers/nlq.js`)

`parseNaturalLanguageQuery(query)` processes the query in several stages as follows:

**a) Gender detection**

The query is split into words and each word is checked against two `Set` collections:

```
MALE_WORDS   = { male, man, men, boy, boys, guy, guys }
FEMALE_WORDS = { female, woman, women, girl, girls, lady, ladies }
```

If only male (or only female) words are found, `gender` is set accordingly.

**b) Age group detection**

Entries are checked against four sets:

```
CHILD_WORDS  = { child, children, kid, kids }
TEEN_WORDS   = { teen, teenager, adolescent, … }
ADULT_WORDS  = { adult, adults }
SENIOR_WORDS = { senior, elderly, old, older, … }
```

**c) Numeric age range detection**

| Phrase pattern                                       | Result                   |
| ---------------------------------------------------- | ------------------------ |
| `in their 30s` / `in their 40s`                      | `min_age=30, max_age=39` |
| `between 20 and 40`                                  | `min_age=20, max_age=40` |
| `over / above / older than / at least 30`            | `min_age=30`             |
| `under / below / younger than / at most 25 / almost` | `max_age=25`             |
| `young`                                              | `min_age=16, max_age=24` |

**d) Country detection**

A `COUNTRY_MAP` object is built at module load time from the `countries-list` package — it maps every lowercase country name to its ISO 3166-1 alpha-2 code. Other abbreviated country names or codes (`usa → US`, `uk → GB`, `ivory coast → CI`, etc.) are merged in via `Object.assign` and the entries are sorted longest-first so that multi-word names (e.g. `"democratic republic of congo"`) match before shorter substrings (e.g. `"congo"`).

**e) Result**

`parseNaturalLanguageQuery` returns a plain object (`parsedFilters`) containing only the keys it could extract. If the object is empty (nothing was understood), the route returns `400 — "Missing parameter"`. Otherwise, the same parameterized SQL logic used by `GET /api/profiles` is applied.

The response echoes the parsed filters back to the caller:

```json
{
  "status": "success",
  "query": "women over 30 from nigeria",
  "parsed": { "gender": "female", "min_age": 30, "country_id": "NG" },
  "page": 1,
  "limit": 10,
  "total": 27,
  "data": [ { ...profile }, ... ]
}
```

---

## Endpoints Reference

### `GET /`

Health check

```json
{ "status": "OK", "message": "Name Classification API is running" }
```

---

### `GET /api/profiles`

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

**Example Requests**

```
GET /api/profiles
GET /api/profiles?gender=female&age_group=adult
GET /api/profiles?country_id=NG&sort_by=age&order=asc&page=2&limit=20
GET /api/profiles?min_age=25&max_age=40&min_gender_probability=0.9
```

**Success Response** — `200 OK`

```json
{
  "status": "success",
  "page": 1,
  "limit": 10,
  "total": 412,
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

### `GET /api/profiles/search`

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
GET /api/profiles/search?q=elderly women from brazil
```

> **Example — filter intersection:** `GET /api/profiles/search?q=young teenagers from Nigeria`
>
> Two independent filters are parsed from this query:
>
> - `young` → `min_age: 16, max_age: 24`
> - `teenagers` → `age_group: "teenager"` (database rows where `age` is 13–19)
>
> Applied together, the effective age window becomes **16–19** — the overlap between the `young` age cap (≤ 24) and the `teenager` age group floor (≥ 13), further bounded by the `teenager` ceiling (≤ 19). Only Nigerian profiles in that 16–19 range are returned.

**Success Response** — `200 OK`

```json
{
  "status": "success",
  "query": "women over 30 from nigeria",
  "parsed": {
    "gender": "female",
    "min_age": 30,
    "country_id": "NG"
  },
  "page": 1,
  "limit": 10,
  "total": 27,
  "data": [ { ...profile }, ... ]
}
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

All error responses follow the same structure:

```json
{ "status": "error", "message": "<error description>" }
```

| Status | Condition                                                   |
| ------ | ----------------------------------------------------------- |
| `400`  | Missing or empty required parameter                         |
| `401`  | Missing or invalid authentication token                     |
| `403`  | Forbidden — insufficient role permissions                   |
| `404`  | Profile not found                                           |
| `422`  | Invalid parameter type (value present but fails validation) |
| `500`  | Internal server error                                       |
| `502`  | Upstream API failure (genderize / agify / nationalize)      |

---

## Running Locally

```bash
# 1. Clone the repository
git clone https://github.com/MyITjournal/db-query-engine.git
cd your-folder-name

# 2. Install dependencies
npm install

# 3. Configure environment variables
```

Create a `.env` file in the project root:

```env
DATABASE_URL=postgresql://postgres:your_password@localhost:5432/your_db_name
DATABASE_SSL=false

GITHUB_CLIENT_ID=your_github_app_client_id
GITHUB_CLIENT_SECRET=your_github_app_client_secret
GITHUB_CALLBACK_URL=http://localhost:3000/auth/github/callback

JWT_ACCESS_SECRET=some_long_random_secret_32_plus_chars
JWT_REFRESH_SECRET=another_long_random_secret_32_plus_chars
```

```bash
# 4. Start the server
node index.js
```

The server starts on port `3000`. On every start, Sequelize drops and recreates the `db_profiles` table, then seeds it with the 2026 profiles from `seed_profiles.json`.

---

**Testing:**

```bash
# Health check
curl http://localhost:3000/

# List all profiles (paginated)
curl "http://localhost:3000/api/profiles"

# Filter profiles
curl "http://localhost:3000/api/profiles?gender=female&age_group=adult&country_id=NG"

# Natural language search
curl "http://localhost:3000/api/profiles/search?q=men+in+their+30s+from+the+UK"
```

---

Live URL: `https://db-query-engine-myitjournal8137-upfultli.leapcell.dev`
