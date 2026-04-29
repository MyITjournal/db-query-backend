import jwt from "jsonwebtoken";
import { v7 as uuidv7 } from "uuid";
import config from "../config/index.js";

const ACCESS_EXPIRY = 3 * 60;
const REFRESH_EXPIRY = 5 * 60;

export function signTokens(user) {
  const jti = uuidv7();

  const accessToken = jwt.sign(
    { sub: user.id, role: user.role, username: user.username },
    config.JWT_ACCESS_SECRET,
    { expiresIn: ACCESS_EXPIRY },
  );

  const refreshToken = jwt.sign(
    { sub: user.id, jti },
    config.JWT_REFRESH_SECRET,
    { expiresIn: REFRESH_EXPIRY },
  );

  const refreshExpiresAt = new Date(Date.now() + REFRESH_EXPIRY * 1000);

  return { accessToken, refreshToken, jti, refreshExpiresAt };
}

export function verifyAccessToken(token) {
  return jwt.verify(token, config.JWT_ACCESS_SECRET);
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, config.JWT_REFRESH_SECRET);
}
