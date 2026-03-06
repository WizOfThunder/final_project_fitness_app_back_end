const mongoose = require('mongoose');

const workoutPlanItemSchema = new mongoose.Schema({
  exercise_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Exercise', required: true },
  sets: Number,
  reps: Number,
  duration: Number
});

const workoutPlanSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  generated_by: { type: String, enum: ['AI', 'trainer'], required: true },
  status: { type: String, enum: ['draft', 'verified', 'modified', 'denied'], default: 'draft' },
  validation_note: String,
  items: [workoutPlanItemSchema],
  created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('WorkoutPlan', workoutPlanSchema);
