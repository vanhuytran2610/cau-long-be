const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { sendResponse } = require("../helper.js");
const { Admin, BlacklistedToken } = require("../db_migration.js");

const router = express.Router();

const authenticateJWT = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return sendResponse(res, 401, req.t("unauthenticated"), null);
  }

  BlacklistedToken.findOne({ token })
    .then((blacklisted) => {
      if (blacklisted) return sendResponse(res, 401, req.t("blacklisted_token_removed"), null);
      jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return sendResponse(res, 403, req.t("invalid_token"));
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

    const token = jwt.sign(
      { id: admin._id, username: admin.username, type: "admin" },
      process.env.JWT_SECRET,
    );

    sendResponse(res, 200, req.t("admin_login_success"), { username, token });
  } catch (err) {
    // console.error("Login error:", err);
    sendResponse(res, 500, req.t("server_error"), null);
  }
});

// Logout
router.post("/api/admin/logout", authenticateJWT, (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return sendResponse(res, 400, req.t("invalid_token"));
  }

  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.payload) {
    return sendResponse(res, 400, req.t("invalid_token"));
  }

  const expiresAt = decoded.payload.exp
    ? new Date(decoded.payload.exp * 1000)
    : new Date("2099-12-31");

  const blacklistedToken = new BlacklistedToken({ token, expiresAt });

  blacklistedToken
    .save()
    .then(() => sendResponse(res, 200, req.t("admin_logout_success")))
    .catch((err) => {
      console.error("Blacklist token error:", err);
      sendResponse(res, 500, req.t("admin_logout_failed"));
    });
});

// Check Authentication
router.get("/api/admin/check-auth", authenticateJWT, (req, res) => {
  sendResponse(res, 200, req.t("authenticated"), { user: req.user });
});

module.exports = { router, authenticateJWT };
