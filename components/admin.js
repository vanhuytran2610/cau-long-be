const express = require("express");
const jwt = require("jsonwebtoken");
const {
  sendResponse,
  applyLanguage,
  translateToEnglish,
  translateToVietnamese,
  extractGenderCounts,
  applyLanguageForParticipant,
  syncCategoryQuantity,
  syncTranslations,
} = require("../helper.js");
const {
  Category,
  CategoryQuantity,
  Participant,
  QrImage,
} = require("../db_migration.js");
const { authenticateJWT } = require("./auth.js");

const router = express.Router();

async function calculateWithGrok(categoryId) {
  const category = await Category.findById(categoryId);
  if (!category) {
    throw new Error(req.t("category_not_found"));
  }

  if (!category.paymentInfo) {
    throw new Error(req.t("payment_info_missing"));
  }

  const participants = await Participant.find({
    category: categoryId,
    status: "tham gia",
  });
  if (!participants.length) {
    throw new Error(req.t("participants_not_found"));
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
- "Người nhận tiền" = người đã bỏ tiền ra trả trước, được mọi người chuyển khoản hoàn lại.
  KHÔNG phải người chuyển tiền đi — người nhận tiền là người ĐỨNG CHỜ nhận chuyển khoản.
- Nếu có nhiều người đã trả tiền trước:
  + Chọn 1 người làm "người nhận tiền cuối cùng" (ưu tiên người trả nhiều nhất hoặc theo paymentInfo)
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
- Không được để nhiều người cùng là "người nhận tiền cuối"
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

9. QUY TẮC VỀ "số_tiền" trong người_đánh (QUAN TRỌNG):
- số_tiền = số tiền người đó phải CHUYỂN ĐẾN TAY người nhận tiền cuối
- Người NHẬN TIỀN cuối (người đã bỏ tiền ra trước, đang chờ nhận chuyển khoản): số_tiền = 0
- Người đã tạm ứng và được hoàn lại toàn bộ/một phần tiền: số_tiền = 0
- Người bình thường (không tạm ứng, không được set sẵn): "số_tiền" BẮT BUỘC phải lớn hơn 0. TUYỆT ĐỐI không để bằng 0 nếu họ có tham gia đánh.
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

  const response = await fetch("https://api.x.ai/v1/chat/completions", {
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
  });

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

  const normalizeName = (name) =>
    name
      .toLowerCase()
      .replace(/\(.*?\)/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const [paymentResult_en] = await Promise.all([
    translateToEnglish(result.payment_text),
    Promise.all(
      result["người đánh"].map((person) => {
        const participant = participants.find(
          (p) => normalizeName(p.name) === normalizeName(person["tên"]),
        );
        if (participant) {
          return Participant.findByIdAndUpdate(participant._id, {
            money: person["số_tiền"],
          });
        }
      }),
    ),
  ]);

  await Category.findByIdAndUpdate(categoryId, {
    paymentResult: result.payment_text,
    paymentResult_en,
  });

  return result;
}

// List Categories (Admin)
router.get("/api/categories", authenticateJWT, async (req, res) => {
  try {
    const categories = await Category.find().sort({ createdAt: -1 });
    const categoryIds = categories.map((c) => c._id);
    const quantities = await CategoryQuantity.find({
      category_id: { $in: categoryIds },
    });
    const quantityMap = {};
    for (const q of quantities) {
      quantityMap[q.category_id.toString()] = q;
    }
    const result = categories.map((cat) => ({
      ...applyLanguage(cat.toObject(), req.language),
      quantity: quantityMap[cat._id.toString()] || null,
    }));
    sendResponse(res, 200, req.t("category_fetch_success"), result);
  } catch (err) {
    sendResponse(res, 500, req.t("category_fetch_failed"), null);
  }
});

// Get Category by ID (Admin)
router.get("/api/categories/:categoryId", authenticateJWT, async (req, res) => {
  try {
    const { categoryId } = req.params;
    const [category, quantity] = await Promise.all([
      Category.findById(categoryId),
      CategoryQuantity.findOne({ category_id: categoryId }),
    ]);
    if (!category) {
      return sendResponse(res, 404, req.t("category_not_found"), null);
    }

    // if (!category.created_by || category.created_by.toString() !== req.user.id) {
    //   return sendResponse(res, 403, req.t("forbidden"), null);
    // }

    sendResponse(res, 200, req.t("category_fetch_success"), {
      ...applyLanguage(category.toObject(), req.language),
      quantity: quantity || null,
    });
  } catch (err) {
    sendResponse(res, 500, req.t("category_fetch_failed"), null);
  }
});

// Create Category (Admin)
router.post("/api/categories", authenticateJWT, async (req, res) => {
  const { name, content, is_selected = false } = req.body;
  if (!name) {
    return sendResponse(res, 400, req.t("invalid_category_name"));
  }

  try {
    const [nameResult, contentResult] = await Promise.all([
      syncTranslations(name, req.language),
      content
        ? syncTranslations(content, req.language)
        : Promise.resolve({ vi: "", en: "" }),
    ]);
    const { vi: viName, en: enName } = nameResult;
    const { vi: viContent, en: enContent } = contentResult;

    const existingCategory = await Category.findOne({ name: viName });
    if (existingCategory) {
      return sendResponse(res, 400, req.t("existing_category"));
    }

    let male_total = 0;
    let female_total = 0;

    if (content) {
      const counts = await extractGenderCounts(viContent || enContent);
      male_total = counts.male_total;
      female_total = counts.female_total;
    }

    const category = new Category({
      name: viName,
      name_en: enName,
      content: viContent,
      content_en: enContent,
      is_selected: is_selected === true,
      created_by: req.user.id,
    });
    await category.save();

    if (is_selected === true) {
      await Category.updateMany(
        { _id: { $ne: category._id }, created_by: req.user.id },
        { is_selected: false },
      );
    }

    const quantity = await CategoryQuantity.create({
      category_id: category._id,
      male_total,
      female_total,
      male_current: 0,
      female_current: 0,
      male_remain: male_total,
      female_remain: female_total,
    });

    sendResponse(res, 201, req.t("category_created"), {
      ...category.toObject(),
      quantity,
    });
  } catch (err) {
    sendResponse(res, 500, req.t("category_creation_failed"), null);
  }
});

// List Participants by Category (Admin)
router.get(
  "/api/participants/:categoryId",
  authenticateJWT,
  async (req, res) => {
    try {
      const { categoryId } = req.params;

      const [category, participants, quantity] = await Promise.all([
        Category.findById(categoryId),
        Participant.find({ category: categoryId }).populate("category"),
        CategoryQuantity.findOne({ category_id: categoryId }),
      ]);

      if (!category) {
        return sendResponse(res, 404, req.t("category_not_found"), null);
      }

      if (!category.created_by || category.created_by.toString() !== req.user.id) {
        return sendResponse(res, 403, req.t("forbidden"), null);
      }

      if (!participants.length) {
        return sendResponse(res, 200, req.t("participant_fetch_success"), {
          category: {
            ...applyLanguage(category.toObject(), req.language),
            quantity,
          },
          participants: [],
        });
      }

      sendResponse(res, 200, req.t("participant_fetch_success"), {
        category: {
          ...applyLanguage(category.toObject(), req.language),
          quantity,
        },
        participants: participants.map((p) =>
          applyLanguageForParticipant(p.toObject(), req.language),
        ),
      });
    } catch (err) {
      console.error("Error retrieving participants:", err.message);
      sendResponse(res, 500, req.t("participant_fetch_failed"), null);
    }
  },
);

// Add Participant in Admin page
router.post(
  "/api/participants/:categoryId",
  authenticateJWT,
  async (req, res) => {
    const { categoryId } = req.params;
    const { name, status = "tham gia", level, gender } = req.body;

    if (!name) {
      return sendResponse(res, 400, req.t("invalid_participant_name"));
    }

    if (!["tham gia", "lần sau"].includes(status)) {
      return sendResponse(res, 400, req.t("invalid_request"));
    }

    const GENDER_VI = { nam: "nam", nữ: "nữ", male: "nam", female: "nữ" };
    const GENDER_EN = {
      nam: "male",
      nữ: "female",
      male: "male",
      female: "female",
    };
    const viGender = GENDER_VI[gender] || "";
    const enGender = GENDER_EN[gender] || "";

    try {
      const category = await Category.findById(categoryId);
      if (!category) {
        return sendResponse(res, 404, req.t("category_not_found"), null);
      }

      if (!category.created_by || category.created_by.toString() !== req.user.id) {
        return sendResponse(res, 403, req.t("forbidden"), null);
      }

      if (category.isCalculated) {
        return sendResponse(
          res,
          400,
          req.t("calculated_participant_add_failed"),
          null,
        );
      }

      const existingParticipant = await Participant.findOne({
        name: name,
        category: categoryId,
      });

      if (existingParticipant) {
        return sendResponse(res, 400, req.t("existing_participant"));
      }

      // Atomic slot check-and-decrement for "tham gia" submissions with gender
      if (
        status === "tham gia" &&
        viGender &&
        ["nam", "nữ"].includes(viGender)
      ) {
        const isMale = viGender === "nam";
        const remainField = isMale ? "male_remain" : "female_remain";
        const currentField = isMale ? "male_current" : "female_current";

        const quantityDoc = await CategoryQuantity.findOne({
          category_id: categoryId,
        });
        if (quantityDoc) {
          const totalField = isMale ? "male_total" : "female_total";
          if (quantityDoc[totalField] > 0) {
            const updated = await CategoryQuantity.findOneAndUpdate(
              { category_id: categoryId, [remainField]: { $gt: 0 } },
              { $inc: { [currentField]: 1, [remainField]: -1 } },
              { new: true },
            );
            if (!updated) {
              return sendResponse(
                res,
                400,
                req.t("slots_full") || "No remaining slots for this gender",
              );
            }
          }
        }
      }

      const new_participant = new Participant({
        name: name,
        status: status,
        category: categoryId,
        level: level || "",
        gender: viGender,
        gender_en: enGender,
      });
      await new_participant.save();
      await new_participant.populate("category");
      sendResponse(res, 201, req.t("participant_added"), new_participant);
    } catch (err) {
      sendResponse(res, 500, req.t("participant_add_failed"), null);
    }
  },
);

// Update Participant Payment Status
router.put(
  "/api/participants/:categoryId/:participantId",
  authenticateJWT,
  async (req, res) => {
    try {
      const { categoryId, participantId } = req.params;
      const { isPaid } = req.body;

      if (isPaid === undefined || typeof isPaid !== "boolean") {
        return sendResponse(res, 400, req.t("invalid_request"), null);
      }

      const category = await Category.findById(categoryId);
      if (!category) {
        return sendResponse(res, 404, req.t("category_not_found"), null);
      }

      if (!category.created_by || category.created_by.toString() !== req.user.id) {
        return sendResponse(res, 403, req.t("forbidden"), null);
      }

      const participant = await Participant.findOne({
        _id: participantId,
        category: categoryId,
      });
      if (!participant) {
        return sendResponse(res, 404, req.t("participant_not_found"), null);
      }

      const updatedParticipant = await Participant.findByIdAndUpdate(
        participantId,
        { isPaid },
        { new: true, runValidators: true },
      ).populate("category");

      sendResponse(res, 200, req.t("participant_updated"), updatedParticipant);
    } catch (err) {
      console.error("Error updating participant payment status:", err.message);
      sendResponse(res, 500, req.t("participant_update_failed"), null);
    }
  },
);

// Delete Participant
router.delete(
  "/api/participants/:categoryId/:participantId",
  authenticateJWT,
  async (req, res) => {
    try {
      const { categoryId, participantId } = req.params;

      const category = await Category.findById(categoryId);
      if (!category) {
        return sendResponse(res, 404, req.t("category_not_found"), null);
      }

      if (!category.created_by || category.created_by.toString() !== req.user.id) {
        return sendResponse(res, 403, req.t("forbidden"), null);
      }

      if (category.isCalculated) {
        return sendResponse(
          res,
          400,
          req.t("calculated_participant_delete_failed"),
          null,
        );
      }

      const participant = await Participant.findOneAndDelete({
        _id: participantId,
        category: categoryId,
      });
      if (!participant) {
        return sendResponse(res, 404, req.t("participant_not_found"), null);
      }

      if (
        participant.status === "tham gia" &&
        ["nam", "nữ"].includes(participant.gender)
      ) {
        const isMale = participant.gender === "nam";
        const quantityDoc = await CategoryQuantity.findOne({
          category_id: categoryId,
        });
        if (quantityDoc) {
          const totalField = isMale ? "male_total" : "female_total";
          if (quantityDoc[totalField] > 0) {
            await CategoryQuantity.findOneAndUpdate(
              { category_id: categoryId },
              {
                $inc: {
                  [isMale ? "male_current" : "female_current"]: -1,
                  [isMale ? "male_remain" : "female_remain"]: 1,
                },
              },
            );
          }
        }
      }

      sendResponse(res, 200, req.t("participant_deleted"), participant);
    } catch (err) {
      console.error("Error deleting participant:", err.message);
      sendResponse(res, 500, req.t("participant_delete_failed"), null);
    }
  },
);

// Update Category (name, is_selected, content)
router.put("/api/categories/:id", authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, is_selected, content } = req.body;

    if (is_selected === undefined) {
      return sendResponse(res, 400, req.t("is_selected"), null);
    }

    const category = await Category.findById(id);
    if (!category) {
      return sendResponse(res, 404, req.t("category_not_found"), null);
    }

    if (!category.created_by || category.created_by.toString() !== req.user.id) {
      return sendResponse(res, 403, req.t("forbidden"), null);
    }

    if (is_selected === true) {
      await Category.updateMany({ _id: { $ne: id }, created_by: req.user.id }, { is_selected: false });
    }

    const updateFields = { is_selected: is_selected === true };

    const currentContent =
      req.language === "en" ? category.content_en : category.content;
    const contentChanged =
      content !== undefined && content !== "" && content !== currentContent;

    const [nameResult, contentResult] = await Promise.all([
      name ? syncTranslations(name, req.language) : Promise.resolve(null),
      contentChanged
        ? syncTranslations(content, req.language)
        : Promise.resolve(null),
    ]);

    if (name && nameResult) {
      const { vi: viName, en: enName } = nameResult;
      const category_name = await Category.findOne({ name: viName });
      if (category_name && category_name._id.toString() !== id) {
        return sendResponse(res, 400, req.t("existing_category"), null);
      }
      updateFields.name = viName;
      updateFields.name_en = enName;
    }

    if (contentChanged && contentResult) {
      const { vi: viContent, en: enContent } = contentResult;
      updateFields.content = viContent;
      updateFields.content_en = enContent;

      const counts = await extractGenderCounts(viContent || enContent);
      const existing = await CategoryQuantity.findOne({ category_id: id });
      if (existing) {
        const male_current = existing.male_current;
        const female_current = existing.female_current;
        await CategoryQuantity.findOneAndUpdate(
          { category_id: id },
          {
            male_total: counts.male_total,
            female_total: counts.female_total,
            male_remain: Math.max(0, counts.male_total - male_current),
            female_remain: Math.max(0, counts.female_total - female_current),
          },
        );
      } else {
        await CategoryQuantity.create({
          category_id: id,
          male_total: counts.male_total,
          female_total: counts.female_total,
          male_current: 0,
          female_current: 0,
          male_remain: counts.male_total,
          female_remain: counts.female_total,
        });
      }
    } else if (content === "") {
      updateFields.content = "";
      updateFields.content_en = "";
    }

    const [updatedCategory, quantity] = await Promise.all([
      Category.findByIdAndUpdate(id, updateFields, {
        new: true,
        runValidators: true,
      }),
      CategoryQuantity.findOne({ category_id: id }),
    ]);

    sendResponse(res, 200, req.t("category_updated"), {
      ...updatedCategory.toObject(),
      quantity,
    });
  } catch (err) {
    console.error("Update category error:", err.message);
    sendResponse(res, 500, req.t("category_update_failed"), null);
  }
});

// Calculate Expenses
router.post(
  "/api/categories/:id/calculate",
  authenticateJWT,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { paymentInfo } = req.body;

      if (!paymentInfo) {
        return sendResponse(res, 400, req.t("payment_info_missing"), null);
      }

      const category = await Category.findById(id);
      if (!category) {
        return sendResponse(res, 404, req.t("category_not_found"), null);
      }

      if (!category.created_by || category.created_by.toString() !== req.user.id) {
        return sendResponse(res, 403, req.t("forbidden"), null);
      }

      const { vi: viPaymentInfo, en: enPaymentInfo } = await syncTranslations(
        paymentInfo,
        req.language,
      );
      await Category.findByIdAndUpdate(id, {
        paymentInfo: viPaymentInfo,
        paymentInfo_en: enPaymentInfo,
      });

      const expenseResult = await calculateWithGrok(id);

      const updatedCategory = await Category.findByIdAndUpdate(
        id,
        { isCalculated: true },
        { new: true, runValidators: true },
      );

      sendResponse(res, 200, req.t("expenses_calculated"), {
        category: updatedCategory,
        expenses: expenseResult,
      });
    } catch (err) {
      console.error("Error calculating expenses:", err.message);
      sendResponse(res, 500, req.t("server_error"), null);
    }
  },
);

// List QR Images
router.get("/api/qr-images", authenticateJWT, async (req, res) => {
  try {
    const qrImages = await QrImage.find().sort({ createdAt: -1 });
    sendResponse(res, 200, req.t("qr_images_fetched"), qrImages);
  } catch (err) {
    console.error("Error fetching QR images:", err.message);
    sendResponse(res, 500, req.t("server_error"), null);
  }
});

// Delete QR Image
router.delete("/api/qr-images/:id", authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;

    const qrImage = await QrImage.findByIdAndDelete(id);
    if (!qrImage) {
      return sendResponse(res, 404, req.t("qr_image_not_found"), null);
    }

    sendResponse(res, 200, req.t("qr_image_deleted"), qrImage);
  } catch (err) {
    console.error("Error deleting QR image:", err.message);
    sendResponse(res, 500, req.t("server_error"), null);
  }
});

// Export Result (set isShowMoney = true, link QR image)
router.put("/api/categories/:id/export", authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const { qr_img_id, qr_img_url, qr_img_name } = req.body;

    if (!qr_img_id && !qr_img_url) {
      return sendResponse(res, 400, req.t("export_no_qr_image"), null);
    }

    const category = await Category.findById(id);
    if (!category) {
      return sendResponse(res, 404, req.t("category_not_found"), null);
    }

    if (!category.created_by || category.created_by.toString() !== req.user.id) {
      return sendResponse(res, 403, req.t("forbidden"), null);
    }

    if (!category.isCalculated) {
      return sendResponse(res, 400, req.t("export_no_calculation"), null);
    }

    let resolvedQrUrl = category.qr_img_url;

    if (qr_img_id) {
      const qrImage = await QrImage.findById(qr_img_id);
      if (!qrImage) {
        return sendResponse(res, 404, req.t("qr_image_not_found"), null);
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

    sendResponse(res, 200, req.t("export_success"), updatedCategory);
  } catch (err) {
    console.error("Error exporting result:", err.message);
    sendResponse(res, 500, req.t("server_error"), null);
  }
});

// Delete Category
router.delete("/api/categories/:id", authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;

    const category = await Category.findById(id);
    if (!category)
      return sendResponse(res, 404, req.t("category_not_found"), null);

    if (!category.created_by || category.created_by.toString() !== req.user.id)
      return sendResponse(res, 403, req.t("forbidden"), null);

    if (category.isCalculated)
      return sendResponse(res, 400, req.t("category_is_calculated"), null);

    await Participant.deleteMany({ category: id });
    await CategoryQuantity.findOneAndDelete({ category_id: id });
    const deletedCategory = await Category.findByIdAndDelete(id);

    sendResponse(res, 200, req.t("category_deleted"), deletedCategory);
  } catch (err) {
    console.error("Error deleting category:", err.message);
    sendResponse(res, 500, req.t("server_error"), null);
  }
});

module.exports = router;
