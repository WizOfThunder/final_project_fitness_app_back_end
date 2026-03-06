const WorkoutPlan = require('../workout/workout.model');
const DietPlan = require('./diet.model');
const User = require('../users/user.model');

exports.generateWorkout = async (req, res) => {
  try {
    const { user_id } = req.body;
    const user = await User.findById(user_id);
    const plan = await WorkoutPlan.create({
      user_id,
      generated_by: 'AI',
      status: 'draft',
      items: []
    });
    res.json({ message: 'Workout plan generated', plan });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.generateDiet = async (req, res) => {
  try {
    const { user_id } = req.body;
    const user = await User.findById(user_id);
    const plan = await DietPlan.create({
      user_id,
      content: 'AI generated diet plan',
      status: 'verified'
    });
    res.json({ message: 'Diet plan generated', plan });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
