import { createReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import multer from "multer";
import { parse } from "csv-parse";
import { v7 as uuidv7 } from "uuid";
import pool from "../db/index.js";
import { determineAgeGroup } from "../helpers/helperFunctions.js";

const BATCH_SIZE = 200;
const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024;

const VALID_GENDERS = new Set(["male", "female"]);
const VALID_AGE_GROUPS = new Set(["child", "teenager", "adult", "senior"]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, tmpdir()),
  filename: (_req, _file, cb) =>
    cb(null, `import_${Date.now()}_${Math.random().toString(36).slice(2)}.csv`),
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    const isCsv =
      file.mimetype === "text/csv" ||
      file.mimetype === "application/csv" ||
      file.mimetype === "application/octet-stream" ||
      file.originalname.toLowerCase().endsWith(".csv");
    if (isCsv) return cb(null, true);
    cb(
      Object.assign(new Error("Only CSV files are accepted"), {
        code: "INVALID_FILE_TYPE",
      }),
    );
  },
});

export function handleUpload(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({ status: "error", message: err.message });
  });
}

function validateRow(record) {
  const name = record.name?.trim();
  const gender = record.gender?.trim().toLowerCase();
  const ageRaw = record.age?.trim();

  if (!name || !gender || !ageRaw) {
    return { valid: false, reason: "missing_fields" };
  }

  if (!/^\d+$/.test(ageRaw)) {
    return { valid: false, reason: "invalid_age" };
  }
  const age = parseInt(ageRaw, 10);
  if (age < 0 || age > 150) {
    return { valid: false, reason: "invalid_age" };
  }

  if (!VALID_GENDERS.has(gender)) {
    return { valid: false, reason: "missing_fields" };
  }

  let gender_probability = null;
  const gpRaw = record.gender_probability?.trim();
  if (gpRaw) {
    const gp = parseFloat(gpRaw);
    if (isNaN(gp) || gp < 0 || gp > 1) {
      return { valid: false, reason: "missing_fields" };
    }
    gender_probability = gp;
  }

  let country_probability = null;
  const cpRaw = record.country_probability?.trim();
  if (cpRaw) {
    const cp = parseFloat(cpRaw);
    if (!isNaN(cp) && cp >= 0 && cp <= 1) {
      country_probability = cp;
    }
  }

  const agRaw = record.age_group?.trim().toLowerCase();
  const age_group =
    agRaw && VALID_AGE_GROUPS.has(agRaw) ? agRaw : determineAgeGroup(age);

  const country_id = record.country_id?.trim().toUpperCase() || null;
  const country_name = record.country_name?.trim() || null;

  return {
    valid: true,
    row: {
      id: uuidv7(),
      name,
      gender,
      gender_probability,
      age,
      age_group,
      country_id,
      country_name,
      country_probability,
    },
  };
}

async function insertBatch(rows) {
  const placeholders = [];
  const values = [];
  let i = 1;

  for (const row of rows) {
    placeholders.push(
      `($${i}, $${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6}, $${i + 7}, $${i + 8})`,
    );
    values.push(
      row.id,
      row.name,
      row.gender,
      row.gender_probability,
      row.age,
      row.age_group,
      row.country_id,
      row.country_name,
      row.country_probability,
    );
    i += 9;
  }

  const result = await pool.query(
    `INSERT INTO db_profiles
       (id, name, gender, gender_probability, age, age_group,
        country_id, country_name, country_probability)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (name) DO NOTHING`,
    values,
  );

  const inserted = result.rowCount ?? 0;
  return { inserted, duplicates: rows.length - inserted };
}

export async function importProfilesHandler(req, res) {
  if (!req.file) {
    return res.status(400).json({
      status: "error",
      message: "No file uploaded. Use field name 'file'.",
    });
  }

  const filePath = join(tmpdir(), req.file.filename);

  const summary = {
    total_rows: 0,
    inserted: 0,
    skipped: 0,
    reasons: {},
  };

  const recordSkip = (reason, count = 1) => {
    summary.skipped += count;
    summary.reasons[reason] = (summary.reasons[reason] ?? 0) + count;
  };

  try {
    const parser = createReadStream(filePath).pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_column_count: true,
        skip_records_with_error: true,
      }),
    );

    parser.on("skip", () => {
      summary.total_rows += 1;
      recordSkip("missing_fields");
    });

    let batch = [];

    for await (const record of parser) {
      summary.total_rows += 1;

      const result = validateRow(record);
      if (!result.valid) {
        recordSkip(result.reason);
        continue;
      }

      batch.push(result.row);

      if (batch.length >= BATCH_SIZE) {
        const { inserted, duplicates } = await insertBatch(batch);
        summary.inserted += inserted;
        if (duplicates > 0) recordSkip("duplicate_name", duplicates);
        batch = [];
      }
    }

    if (batch.length > 0) {
      const { inserted, duplicates } = await insertBatch(batch);
      summary.inserted += inserted;
      if (duplicates > 0) recordSkip("duplicate_name", duplicates);
    }

    return res.status(200).json({ status: "success", ...summary });
  } finally {
    await unlink(filePath).catch(() => {});
  }
}
