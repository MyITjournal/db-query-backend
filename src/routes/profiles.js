import { Router } from "express";
import pool from "../db/index.js";
import { formatProfile, constructLinks } from "../helpers/helperFunctions.js";
import { parseNaturalLanguageQuery } from "../helpers/nlq.js";
import {
  profilesListRules,
  searchRules,
  createProfileRules,
  handleValidationErrors,
} from "../helpers/validators.js";
import { authorize } from "../middleware/authorize.js";
import { createProfileHandler } from "./createProfile.js";
import { queryCache, buildCacheKey } from "../helpers/queryCache.js";

const router = Router();

const ALLOWED_SORT_FIELDS = {
  age: "age",
  created_at: "created_at",
  gender_probability: "gender_probability",
};

router.get("/", profilesListRules, handleValidationErrors, async (req, res) => {
  const {
    gender,
    age_group,
    country_id,
    min_age,
    max_age,
    min_gender_probability,
    min_country_probability,
  } = req.query;
  const sort_by = req.query.sort_by ?? "created_at";
  const order = (req.query.order ?? "desc").toUpperCase();
  const page = parseInt(req.query.page ?? 1, 10);
  const limit = Math.min(parseInt(req.query.limit ?? 10, 10), 50);
  const offset = (page - 1) * limit;

  const sortCol = ALLOWED_SORT_FIELDS[sort_by] ?? "created_at";

  const conditions = [];
  const values = [];

  if (gender !== undefined) {
    values.push(gender);
    conditions.push(`LOWER(gender) = $${values.length}`);
  }

  if (age_group !== undefined) {
    values.push(age_group);
    conditions.push(`age_group = $${values.length}`);
  }

  if (country_id !== undefined) {
    values.push(country_id.toUpperCase());
    conditions.push(`country_id = $${values.length}`);
  }

  if (min_age !== undefined) {
    values.push(min_age);
    conditions.push(`age >= $${values.length}`);
  }

  if (max_age !== undefined) {
    values.push(max_age);
    conditions.push(`age <= $${values.length}`);
  }

  if (min_gender_probability !== undefined) {
    values.push(min_gender_probability);
    conditions.push(`gender_probability >= $${values.length}`);
  }

  if (min_country_probability !== undefined) {
    values.push(min_country_probability);
    conditions.push(`country_probability >= $${values.length}`);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const cacheKey = buildCacheKey("profiles", {
    gender,
    age_group,
    country_id,
    min_age,
    max_age,
    min_gender_probability,
    min_country_probability,
    sort_by,
    order,
    page,
    limit,
  });
  const cached = queryCache.get(cacheKey);
  if (cached) return res.status(200).json(cached);

  try {
    values.push(limit);
    const limitPh = `$${values.length}`;
    values.push(offset);
    const offsetPh = `$${values.length}`;

    const { rows } = await pool.query(
      `SELECT id, name, gender, gender_probability, age, age_group,
              country_id, country_name, country_probability, created_at,
              COUNT(*) OVER() AS total_count
       FROM db_profiles ${where}
       ORDER BY ${sortCol} ${order}
       LIMIT ${limitPh} OFFSET ${offsetPh}`,
      values,
    );

    const total = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;

    const { total_pages, links } = constructLinks(req, page, limit, total);

    const body = {
      status: "success",
      page,
      limit,
      total,
      total_pages,
      links,
      data: rows.map(formatProfile),
    };
    queryCache.set(cacheKey, body);
    return res.status(200).json(body);
  } catch {
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
});

// GET /api/profiles/search — natural language search
router.get("/search", searchRules, handleValidationErrors, async (req, res) => {
  const q = req.query.q;
  const page = parseInt(req.query.page ?? 1, 10);
  const limit = Math.min(parseInt(req.query.limit ?? 10, 10), 100);
  const offset = (page - 1) * limit;

  const parsed = parseNaturalLanguageQuery(q);

  if (Object.keys(parsed).length === 0) {
    return res
      .status(400)
      .json({ status: "error", message: "Invalid query parameters" });
  }

   const searchCacheKey = buildCacheKey("search", { ...parsed, page, limit });
  const cachedSearch = queryCache.get(searchCacheKey);
  if (cachedSearch) return res.status(200).json(cachedSearch);

  const conditions = [];
  const values = [];

  if (parsed.gender) {
    values.push(parsed.gender);
    conditions.push(`LOWER(gender) = $${values.length}`);
  }

  if (parsed.age_group) {
    values.push(parsed.age_group);
    conditions.push(`age_group = $${values.length}`);
  }

  if (parsed.country_id) {
    values.push(parsed.country_id);
    conditions.push(`country_id = $${values.length}`);
  }

  if (parsed.min_age !== undefined) {
    values.push(parsed.min_age);
    conditions.push(`age >= $${values.length}`);
  }

  if (parsed.max_age !== undefined) {
    values.push(parsed.max_age);
    conditions.push(`age <= $${values.length}`);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    values.push(limit);
    const limitPh = `$${values.length}`;
    values.push(offset);
    const offsetPh = `$${values.length}`;

    const { rows } = await pool.query(
      `SELECT id, name, gender, gender_probability, age, age_group,
              country_id, country_name, country_probability, created_at,
              COUNT(*) OVER() AS total_count
       FROM db_profiles ${where}
       ORDER BY created_at DESC
       LIMIT ${limitPh} OFFSET ${offsetPh}`,
      values,
    );

    const total = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;

    const { total_pages, links } = constructLinks(req, page, limit, total);

    const searchBody = {
      status: "success",
      query: q,
      parsed: {
        ...(parsed.gender && { gender: parsed.gender }),
        ...(parsed.age_group && { age_group: parsed.age_group }),
        ...(parsed.country_id && { country_id: parsed.country_id }),
        ...(parsed.min_age !== undefined && { min_age: parsed.min_age }),
        ...(parsed.max_age !== undefined && { max_age: parsed.max_age }),
      },
      page,
      limit,
      total,
      total_pages,
      links,
      data: rows.map(formatProfile),
    };
    queryCache.set(searchCacheKey, searchBody);
    return res.status(200).json(searchBody);
  } catch {
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
});

router.post(
  "/",
  authorize("admin"),
  createProfileRules,
  handleValidationErrors,
  createProfileHandler,
);

router.get("/export", authorize("admin", "analyst"), async (req, res) => {
  const {
    gender,
    age_group,
    country_id,
    min_age,
    max_age,
    min_gender_probability,
    min_country_probability,
  } = req.query;
  const sort_by = req.query.sort_by ?? "created_at";
  const order = (req.query.order ?? "desc").toUpperCase();
  const sortCol = ALLOWED_SORT_FIELDS[sort_by] ?? "created_at";

  const conditions = [];
  const values = [];

  if (gender !== undefined) {
    values.push(gender);
    conditions.push(`LOWER(gender) = $${values.length}`);
  }
  if (age_group !== undefined) {
    values.push(age_group);
    conditions.push(`age_group = $${values.length}`);
  }
  if (country_id !== undefined) {
    values.push(country_id.toUpperCase());
    conditions.push(`country_id = $${values.length}`);
  }
  if (min_age !== undefined) {
    values.push(min_age);
    conditions.push(`age >= $${values.length}`);
  }
  if (max_age !== undefined) {
    values.push(max_age);
    conditions.push(`age <= $${values.length}`);
  }
  if (min_gender_probability !== undefined) {
    values.push(min_gender_probability);
    conditions.push(`gender_probability >= $${values.length}`);
  }
  if (min_country_probability !== undefined) {
    values.push(min_country_probability);
    conditions.push(`country_probability >= $${values.length}`);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const BATCH_SIZE = 500;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `profiles_${timestamp}.csv`;

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const header =
    "id,name,gender,gender_probability,age,age_group,country_id,country_name,country_probability,created_at\n";
  res.write(header);

  try {
    let offset = 0;
    let fetched;

    do {
      const batchValues = [...values, BATCH_SIZE, offset];
      const limitPh = `$${batchValues.length - 1}`;
      const offsetPh = `$${batchValues.length}`;

      const { rows } = await pool.query(
        `SELECT id, name, gender, gender_probability, age, age_group,
                country_id, country_name, country_probability, created_at
         FROM db_profiles ${where}
         ORDER BY ${sortCol} ${order}
         LIMIT ${limitPh} OFFSET ${offsetPh}`,
        batchValues,
      );

      for (const r of rows) {
        const p = formatProfile(r);
        const line = [
          p.id,
          `"${String(p.name).replace(/"/g, '""')}"`,
          p.gender ?? "",
          p.gender_probability ?? "",
          p.age ?? "",
          p.age_group ?? "",
          p.country_id ?? "",
          `"${String(p.country_name ?? "").replace(/"/g, '""')}"`,
          p.country_probability ?? "",
          p.created_at ?? "",
        ].join(",");
        res.write(line + "\n");
      }

      fetched = rows.length;
      offset += fetched;
    } while (fetched === BATCH_SIZE);

    res.end();
  } catch {
    res.end();
  }
});

export default router;
