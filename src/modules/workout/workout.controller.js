const WorkoutPlan = require('./workout.model');

exports.getMyPlan = async (req, res) => {
  try {
    const plans = await WorkoutPlan.find({ user_id: req.user.id }).populate('items.exercise_id');
    res.json(plans);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getPlan = async (req, res) => {
  try {
    const plan = await WorkoutPlan.findById(req.params.id).populate('items.exercise_id');
    res.json(plan);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.deletePlan = async (req, res) => {
  try {
    await WorkoutPlan.findByIdAndDelete(req.params.id);
    res.json({ message: 'Plan deleted' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
