const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const i18nextMiddleware = require("i18next-http-middleware");
const i18next = require("./i18n.js");
const { sendResponse } = require("./helper.js");

dotenv.config();

const app = express();
app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(i18nextMiddleware.handle(i18next));

// MongoDB Connection — cached for Vercel serverless
let dbConnectionPromise = null;

function connectDB() {
  if (mongoose.connection.readyState >= 1) return Promise.resolve();
  if (!dbConnectionPromise) {
    dbConnectionPromise = mongoose
      .connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 10000,
      })
      .then(() => console.log("Connected to MongoDB"))
      .catch((err) => {
        dbConnectionPromise = null;
        throw err;
      });
  }
  return dbConnectionPromise;
}

app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("MongoDB connection error:", err.message);
    sendResponse(res, 500, "Database connection failed", null);
  }
});

const SUPPORTED_LANGUAGES = ["vi", "en"];

// Get available languages
app.get("/api/languages", (req, res) => {
  sendResponse(res, 200, "OK", {
    languages: SUPPORTED_LANGUAGES,
    current: req.language,
  });
});

// Validate a language code (FE stores and sends it on subsequent requests)
app.post("/api/language", (req, res) => {
  const { lang } = req.body;
  if (!lang || !SUPPORTED_LANGUAGES.includes(lang)) {
    return sendResponse(res, 400, `Unsupported language. Use: ${SUPPORTED_LANGUAGES.join(", ")}`, null);
  }
  sendResponse(res, 200, "OK", { lang });
});

// Routes
const { router: authRouter } = require("./components/auth.js");
const adminRouter = require("./components/admin.js");
const userRouter = require("./components/user.js");

app.use("/", authRouter);
app.use("/", adminRouter);
app.use("/", userRouter);

// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  sendResponse(res, 500, "Internal server error", null);
});

if (process.env.NODE_ENV !== "production") {
  app.listen(process.env.PORT || 3000, () =>
    console.log(`Server running on port ${process.env.PORT || 3000}`),
  );
}

module.exports = app;
