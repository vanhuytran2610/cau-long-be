const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { sendResponse } = require("../helper.js");
const { Admin, BlacklistedToken, RefreshToken } = require("../db_migration.js");

const router = express.Router();

const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function signAccessToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

const authenticateJWT = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return sendResponse(res, 401, req.t("unauthenticated"), null);
  }

  BlacklistedToken.findOne({ token })
    .then((blacklisted) => {
      if (blacklisted) return sendResponse(res, 401, req.t("blacklisted_token_removed"), null);
      jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
          if (err.name === "TokenExpiredError") {
            return res.status(401).json({ statusCode: 401, message: req.t("token_expired"), data: null, code: "TOKEN_EXPIRED" });
          }
          return sendResponse(res, 403, req.t("invalid_token"), null);
        }
        req.user = user;
        next();
      });
    })
    .catch(() => sendResponse(res, 500, req.t("server_error")));
};

// Register Admin
router.post("/api/admin/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return sendResponse(res, 400, req.t("admin_login_no_username_password"), null);
  }

  try {
    const existingAdmin = await Admin.findOne({ username });
    if (existingAdmin) {
      return sendResponse(res, 400, req.t("admin_login_existing_username"), null);
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const admin = new Admin({ username, password: hashedPassword });
    await admin.save();

    sendResponse(res, 201, req.t("admin_register_success"), { username });
  } catch (err) {
    sendResponse(res, 500, req.t("server_error"), null);
  }
});

// Login Admin
router.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return sendResponse(res, 400, req.t("admin_login_no_username_password"), null);
  }

  try {
    const admin = await Admin.findOne({ username });
    if (!admin) {
      return sendResponse(res, 400, req.t("user_not_found"), null);
    }

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      return sendResponse(res, 400, req.t("admin_login_invalid_username_password"), null);
    }

    const accessToken = signAccessToken({ id: admin._id, username: admin.username, type: "admin" });
    const refreshToken = crypto.randomBytes(40).toString("hex");
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS);

    await RefreshToken.create({ token: refreshToken, adminId: admin._id, expiresAt });

    sendResponse(res, 200, req.t("admin_login_success"), { username, accessToken, refreshToken });
  } catch (err) {
    sendResponse(res, 500, req.t("server_error"), null);
  }
});

// Refresh Access Token
router.post("/api/admin/refresh", async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return sendResponse(res, 400, req.t("refresh_token_missing"), null);
  }

  try {
    const stored = await RefreshToken.findOne({ token: refreshToken });
    if (!stored || stored.expiresAt < new Date()) {
      if (stored) await RefreshToken.deleteOne({ _id: stored._id });
      return sendResponse(res, 401, req.t("refresh_token_invalid"), null);
    }

    const admin = await Admin.findById(stored.adminId);
    if (!admin) {
      await RefreshToken.deleteOne({ _id: stored._id });
      return sendResponse(res, 401, req.t("user_not_found"), null);
    }

    // Rotate: issue new access + refresh token
    const newAccessToken = signAccessToken({ id: admin._id, username: admin.username, type: "admin" });
    const newRefreshToken = crypto.randomBytes(40).toString("hex");
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS);

    await RefreshToken.deleteOne({ _id: stored._id });
    await RefreshToken.create({ token: newRefreshToken, adminId: admin._id, expiresAt });

    sendResponse(res, 200, req.t("refresh_success"), {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch (err) {
    sendResponse(res, 500, req.t("server_error"), null);
  }
});

// Logout
router.post("/api/admin/logout", authenticateJWT, async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const { refreshToken } = req.body;

  if (!token) {
    return sendResponse(res, 400, req.t("invalid_token"));
  }

  try {
    const decoded = jwt.decode(token, { complete: true });
    const expiresAt = decoded?.payload?.exp
      ? new Date(decoded.payload.exp * 1000)
      : new Date("2099-12-31");

    await Promise.all([
      new BlacklistedToken({ token, expiresAt }).save(),
      refreshToken ? RefreshToken.deleteOne({ token: refreshToken }) : Promise.resolve(),
    ]);

    sendResponse(res, 200, req.t("admin_logout_success"));
  } catch (err) {
    console.error("Logout error:", err);
    sendResponse(res, 500, req.t("admin_logout_failed"));
  }
});

// Check Authentication
router.get("/api/admin/check-auth", authenticateJWT, (req, res) => {
  sendResponse(res, 200, req.t("authenticated"), { user: req.user });
});

module.exports = { router, authenticateJWT };
