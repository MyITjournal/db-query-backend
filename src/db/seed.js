import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { v7 as uuidv7 } from "uuid";
import pool from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const seedProfiles = async () => {
  const raw = readFileSync(join(__dirname, "seed_profiles.json"), "utf8");
  const { profiles } = JSON.parse(raw);

  console.log(`Seeding ${profiles.length} profiles...`);

  const BATCH_SIZE = 200;
  let inserted = 0;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (let i = 0; i < profiles.length; i += BATCH_SIZE) {
      const chunk = profiles.slice(i, i + BATCH_SIZE);
      const placeholders = chunk
        .map((_, j) => {
          const b = j * 9;
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},NOW())`;
        })
        .join(", ");
      const vals = chunk.flatMap((p) => [
        uuidv7(),
        p.name,
        p.gender,
        p.gender_probability,
        p.age,
        p.age_group,
        p.country_id,
        p.country_name,
        p.country_probability,
      ]);
      const result = await client.query(
        `INSERT INTO db_profiles
           (id, name, gender, gender_probability, age, age_group,
            country_id, country_name, country_probability, created_at)
         VALUES ${placeholders}
         ON CONFLICT (name) DO NOTHING`,
        vals,
      );
      inserted += result.rowCount;
    }

    await client.query("COMMIT");
    console.log(
      `Seeding completed. Inserted: ${inserted} | Skipped (already exists): ${profiles.length - inserted}`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Seeding failed, transaction rolled back:", err.message);
    throw err;
  } finally {
    client.release();
  }
};
