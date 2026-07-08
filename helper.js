const { CategoryQuantity, Participant } = require("./db_migration.js");

// Response Helper Function
const sendResponse = (res, statusCode, message, data = null) => {
  res.status(statusCode).json({ statusCode, message, data });
};

function applyLanguage(categoryObj, lang) {
  if (lang === "en") {
    if (categoryObj.name_en) categoryObj.name = categoryObj.name_en;
    if (categoryObj.content_en) categoryObj.content = categoryObj.content_en;
    if (categoryObj.paymentInfo_en)
      categoryObj.paymentInfo = categoryObj.paymentInfo_en;
    if (categoryObj.paymentResult_en)
      categoryObj.paymentResult = categoryObj.paymentResult_en;
  }
  delete categoryObj.name_en;
  delete categoryObj.content_en;
  delete categoryObj.paymentInfo_en;
  delete categoryObj.paymentResult_en;
  return categoryObj;
}

function applyLanguageForParticipant(participantObj, lang) {
  if (lang === "en") {
    if (participantObj.gender_en)
      participantObj.gender = participantObj.gender_en;
  }
  delete participantObj.gender_en;
  return participantObj;
}

async function translateToEnglish(text) {
  if (!text) return "";
  try {
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
              "You are a translator. Translate the Vietnamese payment plan text to English. Keep all numbers, names, currency amounts, and formatting unchanged. Return only the translated text.",
          },
          { role: "user", content: text },
        ],
        temperature: 0.0,
        max_tokens: 2000,
      }),
    });
    if (!response.ok) return "";
    const data = await response.json();
    return data.choices[0]?.message?.content?.trim() || "";
  } catch (err) {
    console.error("translateToEnglish error:", err.message);
    return "";
  }
}

async function translateToVietnamese(text) {
  if (!text) return "";
  try {
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
              "You are a translator. Translate the given English text to Vietnamese. Keep all numbers, names, currency amounts, and formatting unchanged. Return only the translated text.",
          },
          { role: "user", content: text },
        ],
        temperature: 0.0,
        max_tokens: 2000,
      }),
    });
    if (!response.ok) return "";
    const data = await response.json();
    return data.choices[0]?.message?.content?.trim() || "";
  } catch (err) {
    console.error("translateToVietnamese error:", err.message);
    return "";
  }
}

async function syncTranslations(text, lang) {
  if (lang === "en") {
    return { vi: await translateToVietnamese(text), en: text };
  }
  return { vi: text, en: await translateToEnglish(text) };
}

async function extractGenderCounts(content) {
  if (!content) return { male_total: 0, female_total: 0 };
  try {
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
              'You are a JSON extractor. Extract the number of male (nam) and female (nữ) slots from the given text. Return only valid JSON: {"male_total": number, "female_total": number}. If not specified, return 0.',
          },
          { role: "user", content },
        ],
        temperature: 0.0,
        max_tokens: 100,
      }),
    });
    if (!response.ok) return { male_total: 0, female_total: 0 };
    const data = await response.json();
    const raw = data.choices[0]?.message?.content?.trim() || "{}";
    try {
      const parsed = JSON.parse(raw);
      return {
        male_total: Number(parsed.male_total) || 0,
        female_total: Number(parsed.female_total) || 0,
      };
    } catch {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          male_total: Number(parsed.male_total) || 0,
          female_total: Number(parsed.female_total) || 0,
        };
      }
      return { male_total: 0, female_total: 0 };
    }
  } catch (err) {
    console.error("extractGenderCounts error:", err.message);
    return { male_total: 0, female_total: 0 };
  }
}

async function syncCategoryQuantity(categoryId, quantityDoc) {
  if (
    !quantityDoc ||
    (quantityDoc.male_total === 0 && quantityDoc.female_total === 0)
  )
    return quantityDoc;
  const [maleCurrent, femaleCurrent] = await Promise.all([
    Participant.countDocuments({
      category: categoryId,
      status: "tham gia",
      gender: "nam",
    }),
    Participant.countDocuments({
      category: categoryId,
      status: "tham gia",
      gender: "nữ",
    }),
  ]);
  return CategoryQuantity.findOneAndUpdate(
    { category_id: categoryId },
    {
      male_current: maleCurrent,
      female_current: femaleCurrent,
      male_remain: Math.max(0, quantityDoc.male_total - maleCurrent),
      female_remain: Math.max(0, quantityDoc.female_total - femaleCurrent),
    },
    { new: true },
  );
}

module.exports = {
  sendResponse,
  applyLanguage,
  applyLanguageForParticipant,
  syncTranslations,
  extractGenderCounts,
  translateToEnglish,
  translateToVietnamese,
  syncCategoryQuantity,
};
