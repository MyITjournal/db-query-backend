import { verifyAccessToken } from "../helpers/tokens.js";
import pool from "../db/index.js";

const USER_CACHE_TTL = 60 * 1000;
const userCache = new Map();

function getCachedUser(id) {
  const entry = userCache.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    userCache.delete(id);
    return null;
  }
  return entry.user;
}

function setCachedUser(id, user) {
  userCache.set(id, { user, expiresAt: Date.now() + USER_CACHE_TTL });
}

export async function authenticate(req, res, next) {
  const authHeader = req.headers["authorization"];

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ status: "error", message: "Authentication required" });
  }

  const token = authHeader.slice(7);

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return res
      .status(401)
      .json({ status: "error", message: "Invalid or expired token" });
  }

  try {
    const cached = getCachedUser(payload.sub);
    if (cached) {
      if (!cached.is_active) {
        return res
          .status(403)
          .json({ status: "error", message: "Account is inactive" });
      }
      req.user = cached;
      return next();
    }

    const { rows } = await pool.query(
      "SELECT id, role, username, email, avatar_url, is_active FROM users WHERE id = $1",
      [payload.sub],
    );

    if (rows.length === 0) {
      return res
        .status(401)
        .json({ status: "error", message: "User not found" });
    }

    if (!rows[0].is_active) {
      return res
        .status(403)
        .json({ status: "error", message: "Account is inactive" });
    }

    setCachedUser(payload.sub, rows[0]);
    req.user = rows[0];
    next();
  } catch {
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
}
