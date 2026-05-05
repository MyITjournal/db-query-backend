import { Router } from "express";
import axios from "axios";
import { v7 as uuidv7 } from "uuid";
import jwt from "jsonwebtoken";
import config from "../config/index.js";
import pool from "../db/index.js";
import { signTokens, verifyRefreshToken } from "../helpers/tokens.js";

const router = Router();

async function upsertUser(githubUser) {
  const { id: github_id, login: username, email, avatar_url } = githubUser;

  const { rows } = await pool.query(
    `INSERT INTO users (id, github_id, username, email, avatar_url, last_login_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (github_id) DO UPDATE SET
       username    = EXCLUDED.username,
       email       = EXCLUDED.email,
       avatar_url  = EXCLUDED.avatar_url,
       last_login_at = NOW()
     RETURNING id, username, role, is_active`,
    [uuidv7(), String(github_id), username, email ?? null, avatar_url],
  );

  return rows[0];
}

async function storeRefreshToken(client, jti, userId, expiresAt) {
  await client.query(
    `INSERT INTO refresh_tokens (jti, user_id, expires_at, created_at) VALUES ($1, $2, $3, NOW())`,
    [jti, userId, expiresAt],
  );
}

async function exchangeCodeWithGitHub(code, codeVerifier = null) {
  const params = {
    client_id: config.GITHUB_CLIENT_ID,
    client_secret: config.GITHUB_CLIENT_SECRET,
    code,
    redirect_uri: config.GITHUB_CALLBACK_URL,
  };
  if (codeVerifier) params.code_verifier = codeVerifier;

  const { data } = await axios.post(
    "https://github.com/login/oauth/access_token",
    params,
    { headers: { Accept: "application/json" } },
  );

  if (data.error) throw new Error(data.error_description || data.error);
  return data.access_token;
}

async function getGitHubUser(githubAccessToken) {
  const { data } = await axios.get("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${githubAccessToken}` },
  });
  return data;
}

router.get("/github", (req, res) => {
  const { redirect_uri } = req.query;
  const statePayload = {};

  if (redirect_uri) {
    const allowedOrigins = config.FRONTEND_URL
      ? config.FRONTEND_URL.split(",")
          .map((u) => u.trim())
          .filter(Boolean)
      : [];
    const isAllowed = allowedOrigins.some((origin) =>
      redirect_uri.startsWith(origin),
    );
    if (!isAllowed) {
      console.warn(
        `[auth/github] Rejected redirect_uri="${redirect_uri}" — not in FRONTEND_URL allowlist (${allowedOrigins.join(", ") || "empty"})`,
      );
      return res.status(400).json({
        status: "error",
        message: "Invalid redirect_uri",
      });
    }
    statePayload.redirect_uri = redirect_uri;
  }

  const state = jwt.sign(statePayload, config.JWT_ACCESS_SECRET, {
    expiresIn: 600,
  });

  const params = new URLSearchParams({
    client_id: config.GITHUB_CLIENT_ID,
    redirect_uri: config.GITHUB_CALLBACK_URL,
    scope: "read:user user:email",
    state,
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

router.get("/github/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res
      .status(400)
      .json({ status: "error", message: "Missing code or state" });
  }

  let decoded;
  try {
    decoded = jwt.verify(state, config.JWT_ACCESS_SECRET);
  } catch {
    return res
      .status(400)
      .json({ status: "error", message: "Invalid or expired state" });
  }

  try {
    const ghToken = await exchangeCodeWithGitHub(code);
    const githubUser = await getGitHubUser(ghToken);
    const user = await upsertUser(githubUser);

    if (!user.is_active) {
      return res
        .status(403)
        .json({ status: "error", message: "Account is inactive" });
    }

    const { accessToken, refreshToken, jti, refreshExpiresAt } =
      signTokens(user);

    await storeRefreshToken(pool, jti, user.id, refreshExpiresAt);

    if (decoded.redirect_uri) {
      const url = new URL(decoded.redirect_uri);
      url.searchParams.set("access_token", accessToken);
      url.searchParams.set("refresh_token", refreshToken);
      return res.redirect(url.toString());
    }

    return res.status(200).json({
      status: "success",
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  } catch (err) {
    console.error(
      "[auth/github/callback]",
      err.message,
      err.response?.data ?? "",
    );
    return res
      .status(502)
      .json({ status: "error", message: "GitHub authentication failed" });
  }
});

router.post("/cli/token", async (req, res) => {
  const { code, code_verifier } = req.body;

  if (!code || !code_verifier) {
    return res.status(400).json({
      status: "error",
      message: "code and code_verifier are required",
    });
  }

  try {
    const ghToken = await exchangeCodeWithGitHub(code, code_verifier);
    const githubUser = await getGitHubUser(ghToken);
    const user = await upsertUser(githubUser);

    if (!user.is_active) {
      return res
        .status(403)
        .json({ status: "error", message: "Account is inactive" });
    }

    const { accessToken, refreshToken, jti, refreshExpiresAt } =
      signTokens(user);

    await storeRefreshToken(pool, jti, user.id, refreshExpiresAt);

    return res.status(200).json({
      status: "success",
      access_token: accessToken,
      refresh_token: refreshToken,
      username: user.username,
    });
  } catch {
    return res
      .status(502)
      .json({ status: "error", message: "GitHub authentication failed" });
  }
});

router.post("/refresh", async (req, res) => {
  const { refresh_token } = req.body;

  if (!refresh_token) {
    return res
      .status(400)
      .json({ status: "error", message: "refresh_token is required" });
  }

  let payload;
  try {
    payload = verifyRefreshToken(refresh_token);
  } catch {
    return res
      .status(401)
      .json({ status: "error", message: "Invalid or expired refresh token" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: tokenRows } = await client.query(
      "SELECT jti FROM refresh_tokens WHERE jti = $1",
      [payload.jti],
    );

    if (tokenRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(401).json({
        status: "error",
        message: "Refresh token has been revoked or already used",
      });
    }

    const { rows: userRows } = await client.query(
      "SELECT id, username, role, is_active FROM users WHERE id = $1",
      [payload.sub],
    );

    if (userRows.length === 0 || !userRows[0].is_active) {
      await client.query("ROLLBACK");
      return res
        .status(403)
        .json({ status: "error", message: "Account is inactive" });
    }

    const user = userRows[0];

    await client.query("DELETE FROM refresh_tokens WHERE jti = $1", [
      payload.jti,
    ]);

    const {
      accessToken,
      refreshToken,
      jti: newJti,
      refreshExpiresAt,
    } = signTokens(user);

    await storeRefreshToken(client, newJti, user.id, refreshExpiresAt);

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  } catch {
    await client.query("ROLLBACK");
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  } finally {
    client.release();
  }
});

router.post("/logout", async (req, res) => {
  const { refresh_token } = req.body;

  if (!refresh_token) {
    return res
      .status(400)
      .json({ status: "error", message: "refresh_token is required" });
  }

  let payload;
  try {
    payload = verifyRefreshToken(refresh_token);
  } catch {
    return res.status(200).json({ status: "success", message: "Logged out" });
  }

  await pool.query("DELETE FROM refresh_tokens WHERE jti = $1", [payload.jti]);

  return res.status(200).json({ status: "success", message: "Logged out" });
});

export default router;
