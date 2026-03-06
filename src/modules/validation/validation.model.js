const mongoose = require('mongoose');

const validationLogSchema = new mongoose.Schema({
  plan_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  plan_type: { type: String, enum: ['workout', 'diet'], required: true },
  admin_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, enum: ['verified', 'modified', 'denied'], required: true },
  note: String,
  created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ValidationLog', validationLogSchema);
