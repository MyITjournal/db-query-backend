import express from "express";
import { rateLimit } from "express-rate-limit";
import profilesRouter from "./routes/profiles.js";
import authRouter from "./routes/auth.js";
import { authenticate } from "./middleware/authenticate.js";
import { apiVersion } from "./middleware/apiVersion.js";

const app = express();

app.use(express.json());

app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

app.get("/", (_req, res) => {
  res.json({ status: "OK", message: "Name Classification API is running" });
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    status: "error",
    message: "Too many requests, please try again later",
  },
});

app.use("/auth", authLimiter, authRouter);

app.get("/api/users/me", authenticate, (req, res) => {
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

app.use("/api/profiles", apiVersion, authenticate, profilesRouter);

app.use((_req, res) => {
  res.status(404).json({ status: "error", message: "Route not found" });
});

export default app;
