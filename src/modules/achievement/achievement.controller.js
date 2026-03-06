const { Achievement, UserAchievement } = require('./achievement.model');

exports.getAchievements = async (req, res) => {
  try {
    const achievements = await Achievement.find();
    res.json(achievements);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getMyAchievements = async (req, res) => {
  try {
    const achievements = await UserAchievement.find({ user_id: req.user.id }).populate('achievement_id');
    res.json(achievements);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
