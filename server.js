const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());
console.log("MONGODB_URI:", process.env.MONGODB_URI);
// MongoDB Connection
console.log("MONGODB_URI:", process.env.MONGODB_URI);
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 30000,
    connectTimeoutMS: 60000,
  })
  .then(() => {
    console.log("Connected to MongoDB");
    app.listen(process.env.PORT || 3000, () =>
      console.log(`Server running on port ${process.env.PORT || 3000}`)
    );
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  });

// Schemas
const adminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
});
const Admin = mongoose.model("Admin", adminSchema);

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  is_selected: { type: Boolean, default: false },
});
const Category = mongoose.model("Category", categorySchema);

const participantSchema = new mongoose.Schema({
  name: { type: String, required: true },
  status: { type: String, enum: ["tham gia", "lần sau"], required: true },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Category",
    required: true,
  },
});
const Participant = mongoose.model("Participant", participantSchema);

// BlacklistedToken Model
const blacklistedTokenSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } }, // Manual TTL management
});
const BlacklistedToken = mongoose.model(
  "BlacklistedToken",
  blacklistedTokenSchema
);

// Response Helper Function
const sendResponse = (res, statusCode, message, data = null) => {
  res.status(statusCode).json({ statusCode, message, data });
};

// Middleware to verify JWT
const authenticateJWT = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return sendResponse(res, 401, "Unauthenticated");
  }

  // Check if token is blacklisted
  BlacklistedToken.findOne({ token })
    .then((blacklisted) => {
      if (blacklisted) return sendResponse(res, 401, "Token is expired");
      jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return sendResponse(res, 403, "Invalid token");
        req.user = user;
        next();
      });
    })
    .catch((err) => sendResponse(res, 500, "Server error"));
};

// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  sendResponse(res, 500, "Internal server error", null);
});

// APIs

// Register Admin
app.post("/api/admin/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return sendResponse(res, 400, "Username and password required");
  }

  try {
    const existingAdmin = await Admin.findOne({ username });
    if (existingAdmin) {
      return sendResponse(res, 400, "Username already exists");
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const admin = new Admin({ username, password: hashedPassword });
    await admin.save();

    sendResponse(res, 201, "Admin registered successfully", { username });
  } catch (err) {
    sendResponse(res, 500, "Server error", null);
  }
});

// Login Admin
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return sendResponse(res, 400, "Username and password required");
  }

  try {
    const admin = await Admin.findOne({ username });
    if (!admin) {
      return sendResponse(res, 400, "Invalid credentials");
    }

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      return sendResponse(res, 400, "Invalid credentials");
    }

    const token = jwt.sign(
      { id: admin._id, username: admin.username },
      process.env.JWT_SECRET,
      {
        expiresIn: "1h",
      }
    );
    sendResponse(res, 200, "Login successful", { username, token });
  } catch (err) {
    sendResponse(res, 500, "Server error", null);
  }
});

// List Categories (Admin)
app.get("/api/categories", authenticateJWT, async (req, res) => {
  try {
    const categories = await Category.find();
    sendResponse(res, 200, "Categories retrieved successfully", categories);
  } catch (err) {
    sendResponse(res, 500, "Server error", null);
  }
});

// Create Category (Admin)
app.post("/api/categories", authenticateJWT, async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return sendResponse(res, 400, "Category name required");
  }

  try {
    const existingCategory = await Category.findOne({ name });
    if (existingCategory) {
      return sendResponse(res, 400, "Category already exists");
    }

    const category = new Category({ name });
    await category.save();
    sendResponse(res, 201, "Category created successfully", category);
  } catch (err) {
    sendResponse(res, 500, "Server error", null);
  }
});

// List Participants by Category (Admin)
app.get("/api/participants/:categoryId", authenticateJWT, async (req, res) => {
  const { categoryId } = req.params;
  try {
    const category = Category.findById(categoryId);
    if (!category) {
      return sendResponse(res, 404, "Category not found", null);
    }
    const participants = await Participant.find({
      category: categoryId,
    }).populate("category");
    if (!participants.length) {
      return sendResponse(
        res,
        200,
        "No participants found for this category",
        []
      );
    }
    sendResponse(res, 200, "Participants retrieved successfully", participants);
  } catch (err) {
    sendResponse(res, 500, "Server error", null);
  }
});

// New Delete Participant API
app.delete(
  "/api/participants/:categoryId/:participantId",
  authenticateJWT,
  async (req, res) => {
    try {
      const { categoryId, participantId } = req.params;
      const category = Category.findById(categoryId);
      if (!category) {
        return sendResponse(res, 404, "Category not found", null);
      }
      // Find and delete the participant
      const participant = await Participant.findOneAndDelete({
        _id: participantId,
        category: categoryId,
      });

      if (!participant) {
        return sendResponse(
          res,
          404,
          "Participant not found in this category",
          null
        );
      }

      // Optionally update the category (if needed), but not required here
      sendResponse(res, 200, "Participant deleted successfully", participant);
    } catch (err) {
      console.error("Error deleting participant:", err.message);
      sendResponse(res, 500, "Server error", null);
    }
  }
);

// Submit to Join (Public)
app.post("/api/participants", async (req, res) => {
  const { name, status, categoryId } = req.body;
  if (!name || !status || !categoryId) {
    return sendResponse(res, 400, "Nhập tên đi bạn eeiii!");
  }
  if (!["tham gia", "lần sau"].includes(status)) {
    return sendResponse(res, 400, "Invalid status");
  }

  try {
    const category = await Category.findById(categoryId);
    if (!category) {
      return sendResponse(res, 400, "Ngày này không có đánh cầu nha!");
    }

    const participant = new Participant({ name, status, category: categoryId });
    await participant.save();
    let message;
    if (status === "tham gia") {
      message = "Oke, hẹn gặp bạn trên sân cầu nha!";
    } else if (status === "lần sau") {
      message = "Hẹn bạn lần sau nha!";
    }
    sendResponse(res, 201, message, participant);
  } catch (err) {
    sendResponse(res, 500, "Server error", null);
  }
});

// Update Category API
app.put("/api/categories/:id", authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, is_selected } = req.body;

    // Validate input
    if (is_selected === undefined && !name) {
      return sendResponse(
        res,
        400,
        "At least one of name or is_selected is required",
        null
      );
    }

    // Check if the connection supports transactions
    const session = await mongoose.startSession();
    let transactionSuccessful = false;

    try {
      session.startTransaction();

      // If is_selected is true, set all other categories to false
      if (is_selected === true) {
        await Category.updateMany(
          { _id: { $ne: id } },
          { is_selected: false },
          { session }
        );
      }

      // Update the specific category
      const updatedCategory = await Category.findByIdAndUpdate(
        id,
        { name, is_selected: is_selected === true },
        { new: true, runValidators: true, session }
      );

      if (!updatedCategory) {
        await session.abortTransaction();
        return sendResponse(res, 404, "Category not found", null);
      }

      await session.commitTransaction();
      transactionSuccessful = true;
      sendResponse(res, 200, "Category updated successfully", updatedCategory);
    } catch (err) {
      await session.abortTransaction();
      // Fallback to non-transaction update if transaction fails
      if (err.message.includes("Transaction numbers are only allowed")) {
        console.warn(
          "Transaction failed, falling back to non-transaction update:",
          err.message
        );
        const fallbackUpdate = await Category.findByIdAndUpdate(
          id,
          { name, is_selected: is_selected === true },
          { new: true, runValidators: true }
        );
        if (!fallbackUpdate)
          return sendResponse(res, 404, "Category not found", null);
        // Manually update others if is_selected is true (non-atomic)
        if (is_selected === true) {
          await Category.updateMany(
            { _id: { $ne: id } },
            { is_selected: false }
          );
        }
        return sendResponse(
          res,
          200,
          "Category updated successfully",
          fallbackUpdate
        );
      }
      throw err;
    } finally {
      if (!transactionSuccessful) session.endSession();
    }
  } catch (err) {
    console.error("Error updating category:", err.message);
    sendResponse(res, 500, "Server error", null);
  }
});

// Delete Category API
app.delete("/api/categories/:id", authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;

    // Optionally delete associated participants
    await Participant.deleteMany({ category: id });

    const deletedCategory = await Category.findByIdAndDelete(id);

    if (!deletedCategory)
      return sendResponse(res, 404, "Category not found", null);

    sendResponse(res, 200, "Category deleted successfully", deletedCategory);
  } catch (err) {
    console.error("Error deleting category:", err.message);
    sendResponse(res, 500, "Server error", null);
  }
});

// Logout API
app.post("/api/admin/logout", authenticateJWT, (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];

  // Decode token to get expiration
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.payload.exp) {
    return sendResponse(res, 400, "Invalid token data");
  }
  const expiresAt = new Date(decoded.payload.exp * 1000); // JWT exp is in seconds

  // Blacklist the token
  const blacklistedToken = new BlacklistedToken({ token, expiresAt });
  blacklistedToken
    .save()
    .then(() => sendResponse(res, 200, "Logout successful"))
    .catch((err) => sendResponse(res, 500, "Failed to blacklist token"));
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
