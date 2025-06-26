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

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return sendResponse(res, 403, "Invalid token");
    }
    req.user = user;
    next();
  });
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
    const participants = await Participant.find({
      category: categoryId,
    }).populate("category");
    if (!participants.length) {
      return sendResponse(
        res,
        404,
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
app.delete('/api/participants/:categoryId/:participantId', authenticateJWT, async (req, res) => {
  try {
    const { categoryId, participantId } = req.params;

    // Find and delete the participant
    const participant = await Participant.findOneAndDelete({
      _id: participantId,
      category: categoryId,
    });

    if (!participant) {
      return sendResponse(res, 404, 'Participant not found in this category', null);
    }

    // Optionally update the category (if needed), but not required here
    sendResponse(res, 200, 'Participant deleted successfully', participant);
  } catch (err) {
    console.error('Error deleting participant:', err.message);
    sendResponse(res, 500, 'Server error', null);
  }
});

// Submit to Join (Public)
app.post("/api/participants", async (req, res) => {
  const { name, status, categoryId } = req.body;
  if (!name || !status || !categoryId) {
    return sendResponse(res, 400, "Name, status, and categoryId required");
  }
  if (!["tham gia", "lần sau"].includes(status)) {
    return sendResponse(res, 400, "Invalid status");
  }

  try {
    const category = await Category.findById(categoryId);
    if (!category) {
      return sendResponse(res, 400, "Invalid category");
    }

    const participant = new Participant({ name, status, category: categoryId });
    await participant.save();
    sendResponse(res, 201, "Participant registered successfully", participant);
  } catch (err) {
    sendResponse(res, 500, "Server error", null);
  }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
