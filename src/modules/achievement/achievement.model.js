const mongoose = require('mongoose');

const achievementSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: String,
  rule_type: { type: String, enum: ['challenge_complete', 'streak', 'steps_total'], required: true },
  rule_value: { type: Number, required: true }
});

const userAchievementSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  achievement_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Achievement', required: true },
  earned_at: { type: Date, default: Date.now }
});

const Achievement = mongoose.model('Achievement', achievementSchema);
const UserAchievement = mongoose.model('UserAchievement', userAchievementSchema);

module.exports = { Achievement, UserAchievement };
