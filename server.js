const { sendResponse } = require("./helper.js");

const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(cors());
// MongoDB Connection
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
      console.log(`Server running on port ${process.env.PORT || 3000}`),
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
    paymentInfo: { type: String, default: "" }, // Prompts for payment info
    isShowMoney: { type: Boolean, default: false }, // Whether to show money to users
    qr_img_url: { type: String, default: "" }, // Optional QR code image URL
    paymentResult: { type: String, default: "" }, // Store raw AI response for reference
  },
  { timestamps: true },
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
  quantity: { type: Number, default: 1 },
  money: { type: Number, default: 0 },
  isPaid: { type: Boolean, default: false },
});
const Participant = mongoose.model("Participant", participantSchema);

// BlacklistedToken Model
const blacklistedTokenSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, default: null }, // Manual TTL management
});
const BlacklistedToken = mongoose.model(
  "BlacklistedToken",
  blacklistedTokenSchema,
);

const qrImageSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, unique: true },
    name: { type: String, default: "" },
  },
  { timestamps: true },
);
const QrImage = mongoose.model("QrImage", qrImageSchema);

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

async function calculateWithGroq(categoryId) {
  const category = await Category.findById(categoryId);
  if (!category || !category.paymentInfo) {
    throw new Error("Category not found or paymentInfo is missing");
  }

  const participants = await Participant.find({
    category: categoryId,
    status: "tham gia",
  });
  if (!participants.length) {
    throw new Error("No participants found for this category");
  }

  const participantNames = participants.map((p) => p.name);
  const totalParticipants = participants.length;

  const promptContent = `Thông tin buổi đánh cầu lông:
${category.paymentInfo}

Danh sách người tham gia (${totalParticipants} người):
${participantNames.join(", ")}

Bạn là chuyên gia tính tiền cầu lông.

Nhiệm vụ:
- Phân tích và tính toán chi phí chính xác.
- Chỉ trả về JSON hợp lệ, không markdown, không giải thích.

FORMAT OUTPUT:
{
  "tiền_sân": number,
  "tiền_cầu": number,
  "tổng": number,
  "người_đánh": [
    {
      "tên": string,
      "số_tiếng": number,
      "số_tiền": number,
      "ghi_chú": string
    }
  ],
  "payment_text": string
}

QUY TẮC TÍNH:

1. Xác định:
- Tiền sân
- Tiền cầu (số quả cầu × giá cầu)
- Tổng chi phí
- Ai đã tạm ứng và số tiền đã trả

2. Chia đều:
- Mỗi người phải trả = tổng chi phí / số người

3. Chia theo tiếng:
- Chi phí mỗi tiếng = tiền sân tiếng + tiền cầu tiếng
- Mỗi tiếng chia đều cho người tham gia tiếng đó
- Người tham gia nhiều tiếng = tổng các tiếng
- Người tham gia 1 tiếng = chỉ trả tiếng đó

4. Nếu có số tiền được set sẵn cho từng người:
- Luôn ưu tiên giá trị đó
- Không tự chia lại cho những người khác nếu không có yêu cầu rõ ràng

5. Quy tắc tạm ứng (QUAN TRỌNG):
- “Người nhận tiền” = người đã bỏ tiền ra trả trước, được mọi người chuyển khoản hoàn lại.
  KHÔNG phải người chuyển tiền đi — người nhận tiền là người ĐỨNG CHỜ nhận chuyển khoản.
- Nếu có nhiều người đã trả tiền trước:
  + Chọn 1 người làm “người nhận tiền cuối cùng” (ưu tiên người trả nhiều nhất hoặc theo paymentInfo)
  + Tất cả công nợ phải quy về người này
  + Tính phần chênh lệch:
    chênh_lệch = số_tiền_đã_trả - số_tiền_phải_trả

  + Nếu chênh_lệch > 0:
    người nhận tiền cuối phải hoàn lại cho người đó
  + Nếu chênh_lệch < 0:
    người đó phải chuyển phần thiếu cho người nhận tiền cuối

- KẾT QUẢ CUỐI:
  CHỈ được phép có 1 người nhận tiền chính trong payment_text

6. RULE CHỐT QUAN TRỌNG:
- Không được để nhiều người cùng là “người nhận tiền cuối”
- Không tạo nhiều vòng chuyển tiền
- Tất cả phải quy về 1 người duy nhất hoặc trường hợp đặc biệt set sẵn

7. FORMAT payment_text:

payment_text phải theo cấu trúc:

✅ Kế hoạch thanh toán

Tổng chi phí: xxx VNĐ (Sân: xxx + Cầu: xxx)

Đã thanh toán:
• A: xxx VNĐ
• B: xxx VNĐ

X là người nhận tiền cuối cùng (mọi người chuyển khoản cho X).

Hoàn tiền (nếu có):
• X chuyển A: xxx VNĐ
• X chuyển B: xxx VNĐ

Danh sách chuyển tiền cho X:
• A: xxx VNĐ
• B: xxx VNĐ
• C: xxx VNĐ

Ghi chú:
• ...

8. EXAMPLES:

--- CASE 1: 1 người trả hết / tạm ứng toàn bộ ---

Ni đã trả hết 465.000 VNĐ. Ni là người nhận tiền → số_tiền của Ni = 0.
Mọi người chuyển tiền cho Ni:
• Huy: 116.000 VNĐ  → số_tiền của Huy = 116000
• Harmon: 116.000 VNĐ
• Hanni: 116.000 VNĐ


--- CASE 2: nhiều người tạm ứng, dồn về 1 người ---

Đã thanh toán:
• Như: 320.000 VNĐ
• Huy: 364.000 VNĐ

Huy là người nhận tiền cuối cùng (mọi người chuyển khoản cho Huy).

Hoàn tiền:
• Huy chuyển Như: 257.000 VNĐ

Mọi người chuyển tiền cho Huy:
• A: 62.000 VNĐ  → số_tiền của A = 62000
• B: 62.000 VNĐ


--- CASE 3: dồn về Như ---

Như là người nhận tiền cuối cùng (mọi người chuyển khoản cho Như).

Hoàn tiền:
• Như chuyển Huy: 301.000 VNĐ

Mọi người chuyển tiền cho Như:
• A: 62.000 VNĐ
• B: 62.000 VNĐ


--- CASE 4: set sẵn tiền từng người ---

Đã set sẵn số tiền:
• A: 50.000 VNĐ
• B: 45.000 VNĐ

Không chia lại, giữ nguyên giá trị đã set.


--- CASE 5: chia theo tiếng ---

• A: 2 tiếng
• B: 1 tiếng

Tiền mỗi tiếng = (sân + cầu) / số người tiếng đó

A = tổng 2 tiếng
B = 1 tiếng

9. QUY TẮC VỀ “số_tiền” trong người_đánh (QUAN TRỌNG):
- số_tiền = số tiền người đó phải CHUYỂN ĐẾN TAY người nhận tiền cuối
- Người NHẬN TIỀN cuối (người đã bỏ tiền ra trước, đang chờ nhận chuyển khoản): số_tiền = 0
- Người đã tạm ứng và được hoàn lại toàn bộ/một phần tiền: số_tiền = 0
- Người bình thường (không tạm ứng, không được set sẵn): “số_tiền” BẮT BUỘC phải lớn hơn 0. TUYỆT ĐỐI không để bằng 0 nếu họ có tham gia đánh.
- Chỉ bằng 0 khi và chỉ khi: Họ là người nhận tiền cuối, hoặc chi phí phải trả của họ đã được tính toán bằng 0 hợp lệ.

Ví dụ (CASE 1): Ni trả hết 465k, 4 người:
- Ni (người nhận tiền, mọi người chuyển cho Ni): số_tiền = 0
- Huy (chuyển tiền cho Ni): số_tiền = 116000
- Harmon (chuyển tiền cho Ni): số_tiền = 116000
- Hanni (chuyển tiền cho Ni): số_tiền = 116000

10. QUY TẮC LÀM TRÒN:
- Tất cả số tiền phải làm tròn xuống đến hàng nghìn gần nhất (floor to nearest 1000)
- Ví dụ: 62273 → 62000, 68400 → 68000, 257727 → 257000
- Áp dụng cho cả số_tiền trong người_đánh và tất cả giá trị trong payment_text

11. KIỂM TRA TÍNH NHẤT QUÁN (SANITY CHECK):
- Tổng số tiền "người_đánh" cần chuyển khoản + Tổng số tiền người thanh toán cuối cùng tự chịu + Số tiền các người tạm ứng khác tự chịu (sau khi trừ phần được hoàn) BẢO ĐẢM phải tương đương với Tổng chi phí buổi tập (chênh lệch tối đa do làm tròn xuống).
- Nếu phát hiện bất kỳ người chơi bình thường nào có số_tiền = 0 mà không có lý do hợp lý, phải tính toán lại để gán đúng chi phí cho họ.

12. OUTPUT RULE:
- Chỉ trả JSON
- Không thêm text ngoài JSON
- Không giải thích
`;

  const response = await fetch(
    "https://api.x.ai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "grok-4.3",
        messages: [
          {
            role: "system",
            content:
              "Bạn là JSON calculator chuyên nghiệp. Luôn trả về đúng định dạng JSON, không thêm bất kỳ text thừa nào.",
          },
          { role: "user", content: promptContent },
        ],
        temperature: 0.0,
        max_tokens: 4000,
      }),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Groq API error: ${error}`);
  }

  const data = await response.json();
  const aiContent = data.choices[0].message.content.trim();

  let parsed;
  try {
    parsed = JSON.parse(aiContent);
  } catch (e) {
    const jsonMatch = aiContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error(
        "AI không trả về JSON hợp lệ: " + aiContent.substring(0, 400),
      );
    }
  }

  const result = {
    "tiền sân": parsed["tiền_sân"] || 0,
    "tiền cầu": parsed["tiền_cầu"] || 0,
    tổng: parsed["tổng"] || 0,
    "người đánh": (parsed["người_đánh"] || []).map((person) => ({
      tên: person["tên"],
      số_tiếng: person["số_tiếng"] || 0,
      số_tiền: Math.floor((person["số_tiền"] || 0) / 1000) * 1000,
      ghi_chú: person["ghi_chú"] || "",
    })),
    payment_text: parsed["payment_text"] || "",
  };

  // Cập nhật database

  await Category.findByIdAndUpdate(categoryId, {
    paymentResult: result.payment_text,
  });

  const normalizeName = (name) =>
    name
      .toLowerCase()
      .replace(/\(.*?\)/g, "")
      .replace(/\s+/g, " ")
      .trim();

  for (const person of result["người đánh"]) {
    const participant = participants.find(
      (p) => normalizeName(p.name) === normalizeName(person["tên"]),
    );
    if (participant) {
      await Participant.findByIdAndUpdate(participant._id, {
        money: person["số_tiền"],
      });
    }
  }

  return result;
}

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
    return sendResponse(res, 400, "Username and password are required!");
  }

  try {
    const existingAdmin = await Admin.findOne({ username });
    if (existingAdmin) {
      return sendResponse(res, 400, "Username is available!");
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const admin = new Admin({ username, password: hashedPassword });
    await admin.save();

    sendResponse(res, 201, "Register Admin Successfully!", { username });
  } catch (err) {
    sendResponse(res, 500, "Server error", null);
  }
});

// Login Admin
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return sendResponse(res, 400, "Username and password are required!");
  }

  try {
    const admin = await Admin.findOne({ username });
    if (!admin) {
      return sendResponse(res, 400, "Invalid login information!");
    }

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      return sendResponse(res, 400, "Invalid login information!");
    }

    // Token without expiration (permanent token)
    const token = jwt.sign(
      {
        id: admin._id,
        username: admin.username,
        type: "admin", // Add user type for better validation
      },
      process.env.JWT_SECRET,
      // No expiresIn option = token never expires
    );

    sendResponse(res, 200, "Login Successfully!", {
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
    sendResponse(res, 200, "Fetch categories successfully!", categories);
  } catch (err) {
    sendResponse(res, 500, "Server error", null);
  }
});

// Get Selected Category (User)
app.get("/api/user/category", async (req, res) => {
  try {
    const category = await Category.findOne({ is_selected: true });
    if (!category) {
      return sendResponse(res, 200, "No selected date!", null);
    }
    sendResponse(res, 200, "Get selected date successfully!", category);
  } catch (err) {
    sendResponse(res, 500, "Server error", null);
  }
});

// List All Categories (User) - public
app.get("/api/user/categories", async (req, res) => {
  try {
    const categories = await Category.find({ isShowMoney: true }).sort({
      createdAt: -1,
    });

    const result = await Promise.all(
      categories.map(async (category) => {
        const participants = await Participant.find({ category: category._id });
        return { ...category.toObject(), participants };
      }),
    );

    if (result.length === 0) {
      return sendResponse(res, 404, "No categories found!", null);
    }

    sendResponse(res, 200, "Fetch categories successfully!", result);
  } catch (err) {
    sendResponse(res, 500, "Server error", null);
  }
});

// Create Category (Admin)
app.post("/api/categories", authenticateJWT, async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return sendResponse(res, 400, "Nhập ngày đi bạn eeiii!");
  }

  try {
    const existingCategory = await Category.findOne({ name });
    if (existingCategory) {
      return sendResponse(res, 400, "This data is available!");
    }

    const category = new Category({ name });
    await category.save();
    sendResponse(res, 201, "Create vote date successfully!", category);
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
      return sendResponse(res, 404, "Vote date not found", null);
    }

    // Fetch participants
    const participants = await Participant.find({
      category: categoryId,
    }).populate("category");

    // If no participants, return empty array
    if (!participants.length) {
      return sendResponse(res, 200, "No participants found for this date", {
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
      const { isPaid } = req.body;

      if (isPaid === undefined || typeof isPaid !== "boolean") {
        return sendResponse(res, 400, "isPaid must be a boolean value", null);
      }

      const category = await Category.findById(categoryId);
      if (!category) {
        return sendResponse(res, 404, "Category not found", null);
      }

      const participant = await Participant.findOne({
        _id: participantId,
        category: categoryId,
      });

      if (!participant) {
        return sendResponse(
          res,
          404,
          "Participant not found in this category",
          null,
        );
      }

      const updatedParticipant = await Participant.findByIdAndUpdate(
        participantId,
        { isPaid },
        { new: true, runValidators: true },
      ).populate("category");

      sendResponse(
        res,
        200,
        "Participant payment status updated successfully",
        updatedParticipant,
      );
    } catch (err) {
      console.error("Error updating participant payment status:", err.message);
      sendResponse(res, 500, "Server error", null);
    }
  },
);

// Delete Participant API
app.delete(
  "/api/participants/:categoryId/:participantId",
  authenticateJWT,
  async (req, res) => {
    try {
      const { categoryId, participantId } = req.params;

      const category = await Category.findById(categoryId);
      if (!category) {
        return sendResponse(res, 404, "Category not found", null);
      }

      if (category.isCalculated) {
        return sendResponse(
          res,
          400,
          "Cannot delete participant after expenses have been calculated",
          null,
        );
      }

      const participant = await Participant.findOneAndDelete({
        _id: participantId,
        category: categoryId,
      });

      if (!participant) {
        return sendResponse(
          res,
          404,
          "Participant not found in this category",
          null,
        );
      }

      sendResponse(res, 200, "Participant deleted successfully", participant);
    } catch (err) {
      console.error("Error deleting participant:", err.message);
      sendResponse(res, 500, "Server error", null);
    }
  },
);

// Submit to Join (Public)
app.post("/api/participants", async (req, res) => {
  const { name, status, categoryId, quantity } = req.body;
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

    const participant = new Participant({
      name,
      status,
      category: categoryId,
      quantity: quantity,
    });
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

// Update Category API (only is_selected)
app.put("/api/categories/:id", authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, is_selected } = req.body;

    if (is_selected === undefined) {
      return sendResponse(res, 400, "is_selected is required", null);
    }

    const category = await Category.findById(id);
    if (!category) {
      return sendResponse(res, 404, "Category not found", null);
    }

    if (is_selected === true) {
      await Category.updateMany({ _id: { $ne: id } }, { is_selected: false });
    }

    const updatedCategory = await Category.findByIdAndUpdate(
      id,
      { name, is_selected: is_selected === true },
      { new: true, runValidators: true },
    );

    sendResponse(res, 200, "Category updated successfully", updatedCategory);
  } catch (err) {
    console.error("Error updating category:", err.message);
    sendResponse(res, 500, "Server error", null);
  }
});

// Calculate Expenses API
app.post("/api/categories/:id/calculate", authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const { paymentInfo } = req.body;

    if (!paymentInfo) {
      return sendResponse(res, 400, "paymentInfo is required", null);
    }

    const category = await Category.findById(id);
    if (!category) {
      return sendResponse(res, 404, "Category not found", null);
    }

    await Category.findByIdAndUpdate(id, { paymentInfo });

    const expenseResult = await calculateWithGroq(id);

    const updatedCategory = await Category.findByIdAndUpdate(
      id,
      { isCalculated: true },
      { new: true, runValidators: true },
    );

    sendResponse(res, 200, "Expenses calculated successfully", {
      category: updatedCategory,
      expenses: expenseResult,
    });
  } catch (err) {
    console.error("Error calculating expenses:", err.message);
    sendResponse(res, 500, "Server error", null);
  }
});

// List QR Images API (Admin)
app.get("/api/qr-images", authenticateJWT, async (req, res) => {
  try {
    const qrImages = await QrImage.find().sort({ createdAt: -1 });
    sendResponse(res, 200, "Fetch QR images successfully", qrImages);
  } catch (err) {
    console.error("Error fetching QR images:", err.message);
    sendResponse(res, 500, "Server error", null);
  }
});

// Delete QR Image API (Admin)
app.delete("/api/qr-images/:id", authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;

    const qrImage = await QrImage.findByIdAndDelete(id);
    if (!qrImage) {
      return sendResponse(res, 404, "QR image not found", null);
    }

    sendResponse(res, 200, "QR image deleted successfully", qrImage);
  } catch (err) {
    console.error("Error deleting QR image:", err.message);
    sendResponse(res, 500, "Server error", null);
  }
});

// Export Result API (Admin) - set isShowMoney = true, link QR image to category and save to pool
app.put("/api/categories/:id/export", authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const { qr_img_id, qr_img_url, qr_img_name } = req.body;

    if (!qr_img_id && !qr_img_url) {
      return sendResponse(
        res,
        400,
        "Upload ảnh QR trước khi show kết quả nha",
        null,
      );
    }

    const category = await Category.findById(id);
    if (!category) {
      return sendResponse(res, 404, "Category not found", null);
    }

    if (!category.isCalculated) {
      return sendResponse(
        res,
        400,
        "Expenses have not been calculated yet",
        null,
      );
    }

    let resolvedQrUrl = category.qr_img_url;

    if (qr_img_id) {
      const qrImage = await QrImage.findById(qr_img_id);
      if (!qrImage) {
        return sendResponse(res, 404, "QR image not found", null);
      }
      resolvedQrUrl = qrImage.url;
    } else if (qr_img_url) {
      let qrImage = await QrImage.findOne({ url: qr_img_url });
      if (!qrImage) {
        qrImage = await QrImage.create({
          url: qr_img_url,
          name: qr_img_name || "",
        });
      }
      resolvedQrUrl = qrImage.url;
    }

    const updatedCategory = await Category.findByIdAndUpdate(
      id,
      { isShowMoney: true, qr_img_url: resolvedQrUrl },
      { new: true, runValidators: true },
    );

    sendResponse(res, 200, "Result exported successfully", updatedCategory);
  } catch (err) {
    console.error("Error exporting result:", err.message);
    sendResponse(res, 500, "Server error", null);
  }
});

// Get Payment Result (User) - public
app.get("/api/user/category/:id/result", async (req, res) => {
  try {
    const { id } = req.params;

    const category = await Category.findById(id);
    if (!category) {
      return sendResponse(res, 404, "Category not found", null);
    }

    if (!category.isShowMoney) {
      return sendResponse(res, 200, "Result is not available yet", null);
    }

    const participants = await Participant.find({
      category: id,
      status: "tham gia",
    }).select("name money isPaid");

    sendResponse(res, 200, "Get result successfully", {
      ...category.toObject(),
      participants,
    });
  } catch (err) {
    console.error("Error getting result:", err.message);
    sendResponse(res, 500, "Server error", null);
  }
});

// Delete Category API
app.delete("/api/categories/:id", authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;

    const category = await Category.findById(id);
    if (!category)
      return sendResponse(res, 404, "Vote date not found", null);

    if (category.isCalculated)
      return sendResponse(res, 400, "Cannot delete a vote date that has already been calculated", null);

    await Participant.deleteMany({ category: id });
    const deletedCategory = await Category.findByIdAndDelete(id);

    sendResponse(res, 200, "Vote date deleted successfully", deletedCategory);
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
