import { Sequelize, DataTypes } from "sequelize";
import config from "../config/index.js";
import { seedProfiles } from "./seed.js";
import pool from "./index.js";

const sequelize = new Sequelize(config.DATABASE_URL, {
  dialect: "postgres",
  dialectOptions: {
    ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : false,
  },
  logging: false,
});

sequelize.define(
  "db_profile",
  {
    id: { type: DataTypes.UUID, primaryKey: true },
    name: { type: DataTypes.STRING(255), allowNull: false, unique: true },
    gender: DataTypes.STRING(20),
    gender_probability: DataTypes.FLOAT,
    age: DataTypes.INTEGER,
    age_group: DataTypes.STRING(20),
    country_id: DataTypes.CHAR(2),
    country_name: DataTypes.STRING(100),
    country_probability: DataTypes.FLOAT,
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "db_profiles",
    timestamps: false,
    indexes: [
      { unique: true, fields: ["name"], name: "db_profiles_name_unique_idx" },
      { fields: ["gender"], name: "db_profiles_gender_idx" },
      { fields: ["age_group"], name: "db_profiles_age_group_idx" },
      { fields: ["country_id"], name: "db_profiles_country_id_idx" },
      { fields: ["age"], name: "db_profiles_age_idx" },
    ],
  },
);

sequelize.define(
  "user",
  {
    id: { type: DataTypes.STRING(36), primaryKey: true },
    github_id: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    username: { type: DataTypes.STRING(255), allowNull: false },
    email: DataTypes.STRING(255),
    avatar_url: DataTypes.STRING(500),
    role: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: "analyst",
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    last_login_at: DataTypes.DATE,
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  { tableName: "users", timestamps: false },
);

sequelize.define(
  "refresh_token",
  {
    jti: { type: DataTypes.STRING(36), primaryKey: true },
    user_id: { type: DataTypes.STRING(36), allowNull: false },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  { tableName: "refresh_tokens", timestamps: false },
);

export const connectDB = async () => {
  try {
    await sequelize.authenticate();
    console.log("Database connected");
  } catch (error) {
    console.error("Database connection error:", error.message);
    process.exit(1);
  }

  try {
    await sequelize.models.db_profile.sync();
    await sequelize.models.user.sync();
    await sequelize.models.refresh_token.sync();

    const { rows } = await pool.query("SELECT 1 FROM db_profiles LIMIT 1");
    if (rows.length === 0) {
      await seedProfiles();
    }

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'refresh_tokens_user_id_fkey'
        ) THEN
          ALTER TABLE refresh_tokens
            ADD CONSTRAINT refresh_tokens_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
        END IF;
      END$$;
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_profiles_created_at
        ON db_profiles (created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_profiles_gender_prob
        ON db_profiles (gender_probability);

      CREATE INDEX IF NOT EXISTS idx_profiles_gender_country
        ON db_profiles (gender, country_id);

      CREATE INDEX IF NOT EXISTS idx_profiles_gender_age_group
        ON db_profiles (gender, age_group);

      CREATE INDEX IF NOT EXISTS idx_profiles_country_age_group
        ON db_profiles (country_id, age_group);
    `);

    console.log("All tables ready.");
  } catch (error) {
    console.error("Database sync/seed error:", error.message);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
};

export default sequelize;
