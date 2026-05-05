import express from "express";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import profilesRouter from "./routes/profiles.js";
import authRouter from "./routes/auth.js";
import { authenticate } from "./middleware/authenticate.js";
import { apiVersion } from "./middleware/apiVersion.js";
import config from "./config/index.js";

const app = express();

app.set("trust proxy", 1);

app.use(express.json());

const allowedOrigins = config.FRONTEND_URL
  ? config.FRONTEND_URL.split(",").map((u) => u.trim())
  : [];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed =
    allowedOrigins.length === 0 || (origin && allowedOrigins.includes(origin));

  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin ?? "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, X-API-Version",
    );
    if (allowedOrigins.length > 0) res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  next();
});

app.get("/", (_req, res) => {
  res.json({ status: "OK", message: "Insighta Labs+ API is running" });
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    status: "error",
    message: "Too many requests, please try again later",
  },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    status: "error",
    message: "Too many requests, please try again later",
  },
});

app.use("/auth", authLimiter, authRouter);

app.get("/api/users/me", authenticate, apiLimiter, (req, res) => {
  return res.status(200).json({
    status: "success",
    data: {
      id: req.user.id,
      username: req.user.username,
      email: req.user.email ?? null,
      avatar_url: req.user.avatar_url ?? null,
      role: req.user.role,
    },
  });
});

app.use("/api/profiles", apiVersion, authenticate, apiLimiter, profilesRouter);

app.use((_req, res) => {
  res.status(404).json({ status: "error", message: "Route not found" });
});

export default app;
