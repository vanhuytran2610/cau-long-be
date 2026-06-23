// Response Helper Function
const sendResponse = (res, statusCode, message, data = null) => {
  res.status(statusCode).json({ statusCode, message, data });
};

module.exports = { sendResponse };