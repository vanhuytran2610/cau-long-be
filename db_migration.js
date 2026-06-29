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

module.exports = { Admin, Category, Participant, BlacklistedToken, QrImage };