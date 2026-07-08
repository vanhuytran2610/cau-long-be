const express = require("express");
const {
  sendResponse,
  applyLanguage,
  syncCategoryQuantity,
} = require("../helper.js");
const {
  Category,
  CategoryQuantity,
  Participant,
} = require("../db_migration.js");

const router = express.Router();

// Get Selected Category (User)
router.get("/api/user/category", async (req, res) => {
  try {
    const category = await Category.findOne({ is_selected: true });
    if (!category) {
      return sendResponse(res, 200, req.t("no_selected_date"), null);
    }
    const quantity = await CategoryQuantity.findOne({
      category_id: category._id,
    });
    const syncedQuantity = await syncCategoryQuantity(category._id, quantity || null);
    sendResponse(res, 200, req.t("get_selected_success"), {
      ...applyLanguage(category.toObject(), req.language),
      quantity: syncedQuantity || quantity || null,
    });
  } catch (err) {
    sendResponse(res, 500, req.t("server_error"), null);
  }
});

// List All Categories (User) - public
router.get("/api/user/categories", async (req, res) => {
  try {
    const categories = await Category.find({ isShowMoney: true }).sort({
      createdAt: -1,
    });

    const categoryIds = categories.map((c) => c._id);
    const quantities = await CategoryQuantity.find({
      category_id: { $in: categoryIds },
    });
    const quantityMap = {};
    for (const q of quantities) quantityMap[q.category_id.toString()] = q;

    const result = await Promise.all(
      categories.map(async (category) => {
        const participants = await Participant.find({ category: category._id });
        return {
          ...applyLanguage(category.toObject(), req.language),
          participants,
          quantity: quantityMap[category._id.toString()] || null,
        };
      }),
    );

    if (result.length === 0) {
      return sendResponse(res, 404, req.t("no_categories_found"), null);
    }

    sendResponse(res, 200, req.t("category_fetch_success"), result);
  } catch (err) {
    sendResponse(res, 500, req.t("server_error"), null);
  }
});

// Submit to Join (Public)
router.post("/api/participants", async (req, res) => {
  const { name, status, categoryId, quantity, level, gender } = req.body;
  if (!name || !status || !categoryId) {
    return sendResponse(res, 400, req.t("participant_name_required"));
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
      return sendResponse(res, 404, req.t("no_event_found"));
    }

    // Atomic slot check-and-decrement for "tham gia" submissions with gender
    if (status === "tham gia" && viGender && ["nam", "nữ"].includes(viGender)) {
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

    const participant = new Participant({
      name,
      status,
      category: categoryId,
      quantity,
      level: level || "",
      gender: viGender,
      gender_en: enGender,
    });
    await participant.save();

    const message =
      status === "tham gia"
        ? req.t("participant_join_success")
        : req.t("participant_next_time");

    sendResponse(res, 201, message, participant);
  } catch (err) {
    sendResponse(res, 500, req.t("server_error"), null);
  }
});

// Get Payment Result (User) - public
router.get("/api/user/category/:id/result", async (req, res) => {
  try {
    const { id } = req.params;

    const category = await Category.findById(id);
    if (!category) {
      return sendResponse(res, 404, req.t("category_not_found"), null);
    }

    if (!category.isShowMoney) {
      return sendResponse(res, 200, req.t("result_unavailable"), null);
    }

    const participants = await Participant.find({
      category: id,
      status: "tham gia",
    }).select("name money isPaid");

    sendResponse(res, 200, req.t("get_result_success"), {
      ...applyLanguage(category.toObject(), req.language),
      participants,
    });
  } catch (err) {
    console.error("Error getting result:", err.message);
    sendResponse(res, 500, req.t("server_error"), null);
  }
});

module.exports = router;
