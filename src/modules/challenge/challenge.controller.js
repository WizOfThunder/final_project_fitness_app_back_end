const { Challenge, UserChallenge } = require('./challenge.model');

exports.getChallenges = async (req, res) => {
  try {
    const challenges = await Challenge.find();
    res.json(challenges);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.createChallenge = async (req, res) => {
  try {
    const challenge = await Challenge.create({ ...req.body, created_by: req.user.id });
    res.status(201).json(challenge);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.joinChallenge = async (req, res) => {
  try {
    const userChallenge = await UserChallenge.create({
      user_id: req.user.id,
      challenge_id: req.params.id
    });
    res.json(userChallenge);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getMyChallenges = async (req, res) => {
  try {
    const challenges = await UserChallenge.find({ user_id: req.user.id }).populate('challenge_id');
    res.json(challenges);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
