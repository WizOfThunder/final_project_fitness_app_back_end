const mongoose = require('mongoose');

const exerciseSchema = new mongoose.Schema({
  name: { type: String, required: true },
  muscle: String,
  equipment: String,
  difficulty: String,
  youtube_url: String,
  created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Exercise', exerciseSchema);
