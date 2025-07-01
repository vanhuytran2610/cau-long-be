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

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    is_selected: { type: Boolean, default: false },
    isCalculated: { type: Boolean, default: false }, // Indicates if expenses have been calculated
  },
  { timestamps: true }
);
const Category = mongoose.model("Category", categorySchema);

const participantSchema = new mongoose.Schema({
  name: { type: String, required: true },
  status: { type: String, enum: ["tham gia", "lần sau"], required: true },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Category",
    required: true,
  },
  paymentBefore: { type: Number, default: 0 }, // Amount paid before calculation
  paymentDone: { type: Boolean, default: false }, // Indicates if payment is completed
  paidAmount: { type: Number, default: 0 }, // Amount to pay or receive (shareAmount - paymentBefore + otherAmount)
  shareAmount: { type: Number, default: 0 }, // Calculated share per person
  otherAmount: { type: Number, default: 0 }, // Other additional payments
});
const Participant = mongoose.model("Participant", participantSchema);

// BlacklistedToken Model
const blacklistedTokenSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, default: null }, // Manual TTL management
});
const BlacklistedToken = mongoose.model(
  "BlacklistedToken",
  blacklistedTokenSchema
);

// Function to calculate shared expenses
async function calculateSharedExpenses(categoryId, payments) {
  try {
    // Fetch all participants for the category
    const participants = await Participant.find({ category: categoryId });

    // Validate input payments
    if (!payments || !Array.isArray(payments) || payments.length === 0) {
      throw new Error("Payments array is required and must not be empty");
    }

    // Validate all names in payments exist in participants
    const participantNames = participants.map((p) => p._id.toString());
    const errors = [];
    
    for (const payment of payments) {
      if (!participantNames.includes(payment.id)) {
        errors.push({
          message: `Participant ${payment.id} not found in category`,
        });
      }
      if (typeof payment.amount !== "number" || payment.amount < 0) {
        errors.push({
          message: `Invalid amount for ${payment.id}`,
        });
      }
    }

    // If there are validation errors, return them
    if (errors.length > 0) {
      return {
        statusCode: 400,
        errors,
        data: null,
      };
    }

    // Calculate total paid and number of participants
    const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
    const participantCount = participants.length;
    const sharePerPerson = totalPaid / participantCount;

    // Calculate results for each participant
    const results = participants.map((participant) => {
      const payment = payments.find((p) => p.id === participant._id.toString()) || {
        amount: 0,
      };
      const amountOwed = sharePerPerson - payment.amount;

      return {
        id: participant._id,
        name: participant.name,
        paymentBefore: Math.round(payment.amount),
        shareAmount: Math.round(sharePerPerson),
        paidAmount: Math.round(amountOwed), // Positive: needs to pay, Negative: should receive
      };
    });

    // Update participants with new amounts and payment status (without transaction)
    for (const participant of participants) {
      const payment = payments.find((p) => p.id === participant._id.toString());
      await Participant.findByIdAndUpdate(
        participant._id,
        {
          paymentBefore: payment ? Math.round(payment.amount) : 0,
          paidAmount: payment
            ? Math.round(sharePerPerson - payment.amount)
            : Math.round(sharePerPerson),
          shareAmount: Math.round(sharePerPerson),
          paymentDone:
            payment && payment.amount >= sharePerPerson ? true : false,
        }
      );
    }

    return {
      totalPaid,
      sharePerPerson: Math.round(sharePerPerson),
      results,
    };
  } catch (err) {
    throw new Error(`Error calculating shared expenses: ${err.message}`);
  }
}

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
    return sendResponse(res, 400, "Username và password không được để trống!");
  }

  try {
    const existingAdmin = await Admin.findOne({ username });
    if (existingAdmin) {
      return sendResponse(res, 400, "Username đã tồn tại!");
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const admin = new Admin({ username, password: hashedPassword });
    await admin.save();

    sendResponse(res, 201, "Đăng ký tài khoản admin thành công!", { username });
  } catch (err) {
    sendResponse(res, 500, "Server error", null);
  }
});

// Login Admin
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return sendResponse(res, 400, "Username và password không được để trống!");
  }

  try {
    const admin = await Admin.findOne({ username });
    if (!admin) {
      return sendResponse(res, 400, "Thông tin đăng nhập không hợp lệ!");
    }

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      return sendResponse(res, 400, "Thông tin đăng nhập không hợp lệ!");
    }

    // Token without expiration (permanent token)
    const token = jwt.sign(
      {
        id: admin._id,
        username: admin.username,
        type: "admin", // Add user type for better validation
      },
      process.env.JWT_SECRET
      // No expiresIn option = token never expires
    );

    sendResponse(res, 200, "Đăng nhập thành công!", {
      username,
      token,
      // No expiration info since token is permanent
    });
  } catch (err) {
    console.error("Login error:", err); // Add logging for debugging
    sendResponse(res, 500, "Server error", null);
  }
});

// Check Authentication API
app.get("/api/admin/check-auth", authenticateJWT, (req, res) => {
  // If middleware passes, the token is valid and not blacklisted
  sendResponse(res, 200, "Authenticated", { user: req.user });
});

// List Categories (Admin)
app.get("/api/categories", authenticateJWT, async (req, res) => {
  try {
    const categories = await Category.find().sort({ createdAt: -1 });
    sendResponse(res, 200, "Lấy danh sách ngày thành công!", categories);
  } catch (err) {
    sendResponse(res, 500, "Server error", null);
  }
});

// Get Selected Category (User)
app.get("/api/user/category", async (req, res) => {
  try {
    const category = await Category.findOne({ is_selected: true });
    if (!category) {
      return sendResponse(
        res,
        200,
        "Không có ngày nào được chọn để vote!",
        null
      );
    }
    sendResponse(res, 200, "Lấy ngày vote thành công!", category);
  } catch (err) {
    sendResponse(res, 500, "Server error", null);
  }
});

// Create Category (Admin)
app.post("/api/categories", authenticateJWT, async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return sendResponse(res, 400, "Ngày vote không được để trống!");
  }

  try {
    const existingCategory = await Category.findOne({ name });
    if (existingCategory) {
      return sendResponse(res, 400, "Ngày này đã được tạo rồi!");
    }

    const category = new Category({ name });
    await category.save();
    sendResponse(res, 201, "Tạo ngày vote thành công!", category);
  } catch (err) {
    sendResponse(res, 500, "Server error", null);
  }
});

// List Participants by Category (Admin)
app.get("/api/participants/:categoryId", authenticateJWT, async (req, res) => {
  try {
    const { categoryId } = req.params;

    // Validate category
    const category = await Category.findById(categoryId);
    if (!category) {
      return sendResponse(res, 404, "Category not found", null);
    }

    // Fetch participants
    const participants = await Participant.find({
      category: categoryId,
    }).populate("category");

    // If no participants, return empty array
    if (!participants.length) {
      return sendResponse(res, 200, "No participants found for this category", {
        category,
        participants: [],
      });
    }

    const response = {
      category,
      participants,
    };

    sendResponse(res, 200, "Participants retrieved successfully", response);
  } catch (err) {
    console.error("Error retrieving participants:", err.message);
    sendResponse(res, 500, "Server error", null);
  }
});

// Update Participant Payment Status API
app.put(
  "/api/participants/:categoryId/:participantId",
  authenticateJWT,
  async (req, res) => {
    try {
      const { categoryId, participantId } = req.params;
      const { paymentDone, otherAmount } = req.body;

      // Validate input
      if (paymentDone !== undefined && typeof paymentDone !== "boolean") {
        return sendResponse(
          res,
          400,
          "paymentDone must be a boolean value",
          null
        );
      }
      if (
        otherAmount !== undefined &&
        (typeof otherAmount !== "number" || otherAmount < 0)
      ) {
        return sendResponse(
          res,
          400,
          "otherAmount must be a non-negative number",
          null
        );
      }
      if (paymentDone === undefined && otherAmount === undefined) {
        return sendResponse(
          res,
          400,
          "At least one of paymentDone or otherAmount is required",
          null
        );
      }

      // Validate category
      const category = await Category.findById(categoryId);
      if (!category) {
        return sendResponse(res, 404, "Category not found", null);
      }

      // Prevent updates if category is not calculated
      if (!category.isCalculated) {
        return sendResponse(
          res,
          400,
          "Cannot update participant payment status until expenses are calculated",
          null
        );
      }

      // Find the participant
      const participant = await Participant.findOne({
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

      // Prepare update fields
      const updateFields = {};
      if (paymentDone !== undefined) {
        updateFields.paymentDone = paymentDone;
      }
      if (otherAmount !== undefined) {
        updateFields.otherAmount = otherAmount;
        updateFields.paidAmount =
          participant.shareAmount - participant.paymentBefore + otherAmount;
      }

      // Update participant
      const updatedParticipant = await Participant.findByIdAndUpdate(
        participantId,
        updateFields,
        { new: true, runValidators: true }
      ).populate('category');

      sendResponse(
        res,
        200,
        "Participant payment status updated successfully",
        updatedParticipant
      );
    } catch (err) {
      console.error("Error updating participant payment status:", err.message);
      sendResponse(res, 500, "Server error", null);
    }
  }
);

// New Delete Participant API
app.delete(
  "/api/participants/:categoryId/:participantId",
  authenticateJWT,
  async (req, res) => {
    try {
      const { categoryId, participantId } = req.params;

      // Validate category
      const category = await Category.findById(categoryId);
      if (!category) {
        return sendResponse(res, 404, "Category not found", null);
      }

      // Find the participant
      const participant = await Participant.findOne({
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

      // Prevent deletion of paid participants only if isCalculated is true
      if (
        category.isCalculated &&
        (participant.paymentDone ||
          participant.paymentBefore > 0 ||
          participant.otherAmount > 0)
      ) {
        return sendResponse(
          res,
          400,
          "Cannot delete participant who has already paid",
          null
        );
      }

      // Delete the participant (without transaction)
      await Participant.findOneAndDelete({
        _id: participantId,
        category: categoryId,
      });

      // Get remaining participants and their payments
      const remainingParticipants = await Participant.find({
        category: categoryId,
      });
      
      const payments = remainingParticipants
        .filter((p) => p.paymentBefore > 0)
        .map((p) => ({
          id: p._id.toString(), // Convert ObjectId to string
          amount: p.paymentBefore,
        }));

      // Recalculate expenses if there are payments
      let expenseResult = null;
      if (payments.length > 0) {
        expenseResult = await calculateSharedExpenses(categoryId, payments);
        
        // Update isCalculated to true only if currently false
        if (!category.isCalculated) {
          await Category.findByIdAndUpdate(categoryId, { isCalculated: true });
        }
      }

      const response = {
        message: "Participant deleted successfully",
        deletedParticipant: participant,
        expenses: expenseResult,
      };

      sendResponse(
        res,
        200,
        "Participant deleted and expenses recalculated",
        response
      );
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
    const { name, is_selected, payments } = req.body;

    // Validate input
    if (is_selected === undefined && !name && !payments) {
      return sendResponse(
        res,
        400,
        "At least one of name, is_selected, or payments is required",
        null
      );
    }

    // Check for duplicate name if name is being updated
    if (name) {
      const existingCategory = await Category.findOne({
        name: name.trim(),
        _id: { $ne: id },
      });

      if (existingCategory) {
        return sendResponse(res, 400, "Category name already exists", null);
      }
    }

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
      const category = await Category.findById(id);
      if (!category) {
        await session.abortTransaction();
        return sendResponse(res, 404, "Category not found", null);
      }

      const updateFields = { name, is_selected: is_selected === true };

      // Calculate shared expenses if payments are provided
      let expenseResult = null;
      if (payments) {
        expenseResult = await calculateSharedExpenses(id, payments);
      }
      console.log("ex", expenseResult);
      let finalResults = null;
      if (expenseResult?.statusCode == 400) {
        finalResults = {
          message: expenseResult.errors,
        };
      } else {
        finalResults = expenseResult;
      }

      if (
        payments &&
        !category.isCalculated &&
        expenseResult?.statusCode !== 400
      ) {
        updateFields.isCalculated = true; // Set isCalculated only if currently false
      }
      const updatedCategory = await Category.findByIdAndUpdate(
        id,
        updateFields,
        { new: true, runValidators: true, session }
      );

      await session.commitTransaction();
      transactionSuccessful = true;

      const response = {
        category: updatedCategory,
        expenses: finalResults,
      };

      sendResponse(res, 200, "Category updated successfully", response);
    } catch (err) {
      await session.abortTransaction();
      // Fallback to non-transaction update
      if (err.message.includes("Transaction numbers are only allowed")) {
        console.warn(
          "Transaction failed, falling back to non-transaction update:",
          err.message
        );
        const category = await Category.findById(id);
        if (!category) {
          return sendResponse(res, 404, "Category not found", null);
        }

        const updateFields = { name, is_selected: is_selected === true };

        let expenseResult = null;
        if (payments) {
          expenseResult = await calculateSharedExpenses(id, payments);
          console.log("ex", calculateSharedExpenses(id, payments));
        }

        let finalResults = null;
        if (expenseResult?.statusCode == 400) {
          finalResults = {
            errors: expenseResult.errors,
          };
        } else {
          finalResults = expenseResult;
        }

        if (
          payments &&
          !category.isCalculated &&
          expenseResult?.statusCode !== 400
        ) {
          updateFields.isCalculated = true; // Set isCalculated only if currently false
        }
        const fallbackUpdate = await Category.findByIdAndUpdate(
          id,
          updateFields,
          { new: true, runValidators: true }
        );

        if (is_selected === true) {
          await Category.updateMany(
            { _id: { $ne: id } },
            { is_selected: false }
          );
        }

        const response = {
          category: fallbackUpdate,
          expenses: finalResults,
        };

        if (expenseResult?.statusCode === 400) {
          return sendResponse(
            res,
            400,
            "Category updated unsuccessfully",
            response
          );
        }

        return sendResponse(
          res,
          200,
          "Category updated successfully",
          response
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

  if (!token) {
    return sendResponse(res, 400, "No token provided");
  }

  // Decode token to get payload
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.payload) {
    return sendResponse(res, 400, "Invalid token data");
  }

  // Handle both tokens with and without expiration
  let expiresAt;
  if (decoded.payload.exp) {
    // Token has expiration
    expiresAt = new Date(decoded.payload.exp * 1000);
  } else {
    // Token has no expiration - set a far future date for cleanup purposes
    // or set to null if your BlacklistedToken model allows it
    expiresAt = new Date("2099-12-31"); // Far future date
    // Alternative: expiresAt = null; (if your schema allows null)
  }

  // Blacklist the token
  const blacklistedToken = new BlacklistedToken({
    token,
    expiresAt,
    userId: decoded.payload.id, // Optional: store user ID for better tracking
    createdAt: new Date(),
  });

  blacklistedToken
    .save()
    .then(() => sendResponse(res, 200, "Logout successful"))
    .catch((err) => {
      console.error("Blacklist token error:", err);
      sendResponse(res, 500, "Failed to blacklist token");
    });
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
