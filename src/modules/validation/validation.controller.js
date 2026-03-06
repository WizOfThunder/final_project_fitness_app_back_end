const WorkoutPlan = require('../workout/workout.model');
const DietPlan = require('../ai/diet.model');
const ValidationLog = require('./validation.model');

exports.getPending = async (req, res) => {
  try {
    const workouts = await WorkoutPlan.find({ status: 'draft' }).populate('user_id');
    const diets = await DietPlan.find({ status: 'verified' }).populate('user_id');
    res.json({ workouts, diets });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.validatePlan = async (req, res) => {
  try {
    const { action, note } = req.body;
    const { plan_id } = req.params;
    
    let plan = await WorkoutPlan.findById(plan_id);
    let planType = 'workout';
    
    if (!plan) {
      plan = await DietPlan.findById(plan_id);
      planType = 'diet';
    }
    
    plan.status = action;
    plan.validation_note = note;
    await plan.save();
    
    await ValidationLog.create({
      plan_id,
      plan_type: planType,
      admin_id: req.user.id,
      action,
      note
    });
    
    res.json({ message: 'Plan validated', plan });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
