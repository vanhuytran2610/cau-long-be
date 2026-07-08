const mongoose = require("mongoose");

// Schemas
const adminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
});
const Admin = mongoose.model("Admin", adminSchema);

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    name_en: { type: String, default: "" },
    content: { type: String, default: "" },
    content_en: { type: String, default: "" },
    is_selected: { type: Boolean, default: false },
    isCalculated: { type: Boolean, default: false }, // Indicates if expenses have been calculated
    paymentInfo: { type: String, default: "" },
    paymentInfo_en: { type: String, default: "" },
    isShowMoney: { type: Boolean, default: false }, // Whether to show money to users
    qr_img_url: { type: String, default: "" }, // Optional QR code image URL
    paymentResult: { type: String, default: "" },
    paymentResult_en: { type: String, default: "" },
  },
  { timestamps: true },
);
const Category = mongoose.model("Category", categorySchema);

const categoryQuantitySchema = new mongoose.Schema(
  {
    category_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
      unique: true,
    },
    male_total: { type: Number, default: 0 },
    female_total: { type: Number, default: 0 },
    male_current: { type: Number, default: 0 },
    female_current: { type: Number, default: 0 },
    male_remain: { type: Number, default: 0 },
    female_remain: { type: Number, default: 0 },
  },
  { timestamps: true },
);
const CategoryQuantity = mongoose.model(
  "CategoryQuantity",
  categoryQuantitySchema,
);

const participantSchema = new mongoose.Schema(
  {
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
    level: { type: String, default: "" },
    gender: { type: String, enum: ["nam", "nữ", ""], default: "" },
    gender_en: { type: String, enum: ["male", "female", ""], default: "" },
  },
  { timestamps: true },
);
// Covers: find({category}), find({category,status}), countDocuments({category,status,gender})
participantSchema.index({ category: 1, status: 1, gender: 1 });
// Covers: findOne({name, category}) for duplicate name check
participantSchema.index({ name: 1, category: 1 });
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

module.exports = {
  Admin,
  Category,
  CategoryQuantity,
  Participant,
  BlacklistedToken,
  QrImage,
};
