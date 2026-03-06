const ActivityLog = require('./activity.model');

exports.syncActivity = async (req, res) => {
  try {
    const { date, steps, calories, distance } = req.body;
    const activity = await ActivityLog.findOneAndUpdate(
      { user_id: req.user.id, date },
      { steps, calories, distance },
      { upsert: true, new: true }
    );
    res.json(activity);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getHistory = async (req, res) => {
  try {
    const history = await ActivityLog.find({ user_id: req.user.id }).sort({ date: -1 });
    res.json(history);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
