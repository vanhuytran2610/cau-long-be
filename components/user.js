const express = require("express");
const { sendResponse } = require("../helper.js");
const { Category, Participant } = require("../db_migration.js");

const router = express.Router();

function applyLanguage(categoryObj, lang) {
  if (lang === "en") {
    if (categoryObj.name_en) categoryObj.name = categoryObj.name_en;
    if (categoryObj.paymentInfo_en) categoryObj.paymentInfo = categoryObj.paymentInfo_en;
    if (categoryObj.paymentResult_en) categoryObj.paymentResult = categoryObj.paymentResult_en;
  }
  delete categoryObj.name_en;
  delete categoryObj.paymentInfo_en;
  delete categoryObj.paymentResult_en;
  return categoryObj;
}

// Get Selected Category (User)
router.get("/api/user/category", async (req, res) => {
  try {
    const category = await Category.findOne({ is_selected: true });
    if (!category) {
      return sendResponse(res, 200, req.t("no_selected_date"), null);
    }
    sendResponse(res, 200, req.t("get_selected_success"), applyLanguage(category.toObject(), req.language));
  } catch (err) {
    sendResponse(res, 500, req.t("server_error"), null);
  }
});

// List All Categories (User) - public
router.get("/api/user/categories", async (req, res) => {
  try {
    const categories = await Category.find({ isShowMoney: true }).sort({ createdAt: -1 });

    const result = await Promise.all(
      categories.map(async (category) => {
        const participants = await Participant.find({ category: category._id });
        return { ...applyLanguage(category.toObject(), req.language), participants };
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
  const { name, status, categoryId, quantity } = req.body;
  if (!name || !status || !categoryId) {
    return sendResponse(res, 400, req.t("participant_name_required"));
  }
  if (!["tham gia", "lần sau"].includes(status)) {
    return sendResponse(res, 400, req.t("invalid_request"));
  }

  try {
    const category = await Category.findById(categoryId);
    if (!category) {
      return sendResponse(res, 400, req.t("no_event_found"));
    }

    const participant = new Participant({ name, status, category: categoryId, quantity });
    await participant.save();

    const message =
      status === "tham gia" ? req.t("participant_join_success") : req.t("participant_next_time");

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

    const participants = await Participant.find({ category: id, status: "tham gia" }).select(
      "name money isPaid",
    );

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
