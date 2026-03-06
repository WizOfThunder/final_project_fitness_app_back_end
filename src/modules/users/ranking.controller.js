const { UserAchievement } = require('../achievement/achievement.model');

exports.getRanking = async (req, res) => {
  try {
    const ranking = await UserAchievement.aggregate([
      { $group: { _id: '$user_id', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
      { $project: { 'user.password': 0 } }
    ]);
    res.json(ranking);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
