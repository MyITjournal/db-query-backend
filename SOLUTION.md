# Solution: Stage 4B — Insighta Labs+

By Ade Adebayo

---

## Part 1 — Query Performance

### Optimization Approach

The two highest-impact changes with no new infrastructure are the database indexes added to the columns and connection pool limit that was introduced.

**1. Database indexes on filter and sort columns**

Every `GET /api/profiles` and `GET /api/profiles/search` request filters on combinations of `gender`, `age_group`, `country_id`, and `age`, and sorts by `created_at` or `gender_probability`. Without indexes, PostgreSQL must scan the entire `db_profiles` table for every request regardless of how many rows match.

Indexes are defined directly in the Sequelize model and created automatically on startup via `sync()`:

```js
indexes: [
  { unique: true, fields: ["name"] },
  { fields: ["gender"] },
  { fields: ["age_group"] },
  { fields: ["country_id"] },
  { fields: ["age"] },
];
```

These cover the most frequent single-column filter patterns. PostgreSQL can now satisfy a `WHERE gender = 'male'` clause by scanning a compact B-tree index rather than reading every row in the table.

**2. Connection pool with explicit limits**

`pg.Pool` is instantiated once at startup and shared across all requests. Explicit limits were set to prevent unbounded connection growth during traffic spikes and to avoid costly reconnections on a remote database host:

```js
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});
```

`connectionTimeoutMillis: 5000` ensures requests that cannot acquire a connection within 5 seconds fail fast rather than queuing indefinitely.
`idleTimeoutMillis: 30000` keeps connections alive longer to avoid repeated TCP+TLS handshake overhead on a remote host.

### Design Decisions and Trade-offs

| Decision                   | Rationale                                                            | Trade-off                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Indexes on single columns  | Covers the most frequent filter patterns with minimal write overhead | Composite indexes would help multi-column `WHERE` clauses but add more write overhead; single-column indexes were chosen as the practical starting point |
| `max: 10` pool connections | Matches typical managed PostgreSQL connection limits                 | Too high risks exhausting DB server limits; too low causes queuing. 10 is a safe default for a single-instance deployment                                |
| No cache layer yet         | Kept infrastructure minimal (no Redis required)                      | Repeated identical queries still hit the database; an in-process Map cache is the next logical addition                                                  |

### Before / After Query Performance Comparison

Measurements taken against the seeded dataset (~2,000 rows) and projected to larger scales based on index selectivity. All times are approximate round-trip times including network to a remote PostgreSQL host.

| Scenario                                      | Without Indexes    | With Indexes | Improvement                             |
| --------------------------------------------- | ------------------ | ------------ | --------------------------------------- |
| `GET /api/profiles` (no filters, page 1)      | ~80 ms             | ~70 ms       | Minimal — full scan is fast at 2 K rows |
| `GET /api/profiles?gender=male`               | ~85 ms             | ~72 ms       | Small at 2 K rows                       |
| `GET /api/profiles?gender=male&country_id=NG` | ~85 ms             | ~70 ms       | Small at 2 K rows                       |
| Projected: same queries at 1 M rows           | ~2,000–5,000 ms    | ~30–80 ms    | **25–60× faster** (repeated operations) |
| Projected: same queries at 10 M rows          | Timeout / OOM risk | ~50–150 ms   | Order of magnitude                      |

---

## Part 2 — Query Normalization

### Optimization Approach

`parseNaturalLanguageQuery(q)` in `src/helpers/nlq.js` is a **pure, deterministic function**: given the same string it always returns the same object, and semantically equivalent inputs — phrases that express the same demographic constraint — always resolve to the same filter object.

```js
// These two inputs both produce the same object:
parseNaturalLanguageQuery("Nigerian females between ages 20 and 45");
parseNaturalLanguageQuery("Women aged 20–45 living in Nigeria");
// → { gender: "female", country_id: "NG", min_age: 20, max_age: 45 }
```

Because SQL is built directly from the parsed filter object (not from the raw string), these two queries generate identical SQL — including identical parameter values so from the database's perspective, they are basically the same query.

### Design Decisions and Trade-offs

| Decision                                         | Rationale                                                                                                               | Trade-off                                                                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Parse to structured object first, then build SQL | The canonical form is the filter object, not the raw string. Normalisation happens naturally as a by-product of parsing | Works only as well as the keyword vocabulary; novel phrasing that the parser doesn't recognise returns an empty object (400 response) |
| Rule-based keyword parser (no ML)                | Zero latency cost, fully deterministic, no external dependencies                                                        | Fixed vocabulary — cannot handle truly open-ended natural language. Expanding coverage requires updating keyword sets                 |
| Country names matched longest-first              | Prevents "south" from matching before "south africa"                                                                    | More synonym entries = more maintenance                                                                                               |

### What "normalization" means here

There is no cache key to normalise at this stage (no cache layer is currently deployed). The normalisation benefit is structural: because the SQL layer only ever sees the parsed filter object, two semantically identical queries produce byte-identical SQL strings and identical parameter arrays. When a query cache is added later (an in-process Map or Redis), they will automatically share a single cache entry with no additional work.

---

## Part 3 — CSV Data Ingestion

### Implementation: `POST /api/profiles/import`

**Route:** `POST /api/profiles/import`  
**Auth:** admin role required (`Authorization: Bearer <access_token>`, `X-API-Version: 1`)  
**Body:** `multipart/form-data`, field name `file`, value: the CSV file

**Files changed:**

- `src/routes/importProfiles.js` — new file (handler + multer config + validation)
- `src/routes/profiles.js` — one import line + one route line added

**Dependencies added:** `multer`, `csv-parse`

### How it works (step by step)

```
multipart upload
      │
      ▼
multer (disk storage)
  └─ writes bytes to os.tmpdir() as they arrive
  └─ never buffers full file in heap
      │
      ▼
fs.createReadStream(tempFile)
  └─ piped into csv-parse (async iterator mode)
  └─ one record object emitted per row
      │
      ▼
for await (const record of parser)
  └─ validateRow(record)
  │    ├─ name, gender, age present → else: skip("missing_fields")
  │    ├─ age is integer 0–150      → else: skip("invalid_age")
  │    ├─ gender in {male, female}  → else: skip("invalid_gender")
  │    ├─ probabilities 0–1 if set  → else: skip("missing_fields")
  │    └─ age_group derived if absent
  └─ accumulate valid rows into batch[]
      │
  batch.length === 200
      │
      ▼
INSERT INTO db_profiles (...) VALUES (...),(...),... ON CONFLICT (name) DO NOTHING
  └─ rowCount = actually inserted rows
  └─ batch.length - rowCount = duplicates
      │
      ▼
flush final partial batch
      │
      ▼
unlink(tempFile)   ← always, in finally block
      │
      ▼
{ status, total_rows, inserted, skipped, reasons }
```

### How ingestion failures and edge cases are handled

| Scenario                                                                | Behaviour                                                                                                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Missing required field** (`name`, `gender`, or `age` empty or absent) | Row skipped, counted under `reasons.missing_fields`                                                                                                    |
| **Invalid age** (non-integer, decimal, negative, > 150)                 | Row skipped, counted under `reasons.invalid_age`                                                                                                       |
| **Unrecognised gender** (not `male` or `female`)                        | Row skipped, counted under `reasons.invalid_gender`                                                                                                    |
| **Duplicate name** (already in database)                                | `ON CONFLICT DO NOTHING` — PostgreSQL silently ignores the row; counted under `reasons.duplicate_name`                                                 |
| **Wrong column count** (malformed row)                                  | `relax_column_count: true` passes the row through with missing fields; those missing required fields are caught by `validateRow` as `missing_fields`   |
| **Broken encoding / unparseable row**                                   | `skip_records_with_error: true` causes csv-parse to emit a `skip` event; counted under `reasons.malformed_row`                                         |
| **Non-CSV file uploaded**                                               | `multer` fileFilter rejects with `400 Only CSV files are accepted` before the handler runs                                                             |
| **File over 200 MB**                                                    | `multer` rejects with `413` before any parsing begins                                                                                                  |
| **Partial failure mid-stream** (DB error on a batch)                    | Rows already inserted remain committed. The `finally` block still deletes the temp file. The error surfaces as a 500 with whatever rows were processed |
| **A single bad row**                                                    | Never fails the upload. Processing continues to the next record                                                                                        |

### Why streaming (not loading file into memory)

A 500,000-row CSV at ~100 bytes/row is ~50 MB of text. Loading the full file into a JS array before processing would hold that entire structure in the heap, competing with live query memory and risking an OOM on constrained hardware.

`multer.diskStorage` writes upload bytes to the filesystem as they arrive. The handler then opens a `ReadStream` from the temp file and pipes it into `csv-parse`. The event loop processes one record at a time; heap pressure is constant regardless of file size. Each `await insertBatch()` inside the `for await` loop naturally back-pressures the read stream, preventing unbounded accumulation.

### Why 200-row batches

200 rows × 9 columns = 1,800 parameter bindings — well within PostgreSQL's limit of 65,535. A single 200-row `INSERT` generates exactly one DB round-trip. At 500,000 rows, that is 2,500 round-trips vs 500,000 for row-by-row insertion.

### Why `ON CONFLICT DO NOTHING`

The `name` column has a unique index. Letting PostgreSQL enforce uniqueness atomically is both safer and faster than a pre-insert `SELECT` per row. The duplicate count is derived as `batch.length − rowCount` with no extra query.

### Concurrent uploads

Each upload receives a unique temp filename (`import_<timestamp>_<random>`). Concurrent uploads share only the `pg.Pool`, which is designed for concurrent callers. No locking or coordination is required.

---

## Summary

| Part                    | Key Mechanism                                                                                | File(s)                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1 — Query Performance   | B-tree indexes on filter/sort columns; explicit connection pool limits                       | `src/db/sequelize.js`, `src/db/index.js`                 |
| 2 — Query Normalization | Deterministic NLQ parser outputs canonical filter objects; SQL built only from parsed output | `src/helpers/nlq.js`, `src/routes/profiles.js`           |
| 3 — CSV Ingestion       | Streaming CSV parse → row validation → 200-row batch INSERT ON CONFLICT DO NOTHING           | `src/routes/importProfiles.js`, `src/routes/profiles.js` |
