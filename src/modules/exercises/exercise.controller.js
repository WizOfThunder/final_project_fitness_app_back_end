const Exercise = require('./exercise.model');
const axios = require('axios');

exports.getExercises = async (req, res) => {
  try {
    const exercises = await Exercise.find();
    res.json(exercises);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getExercise = async (req, res) => {
  try {
    const exercise = await Exercise.findById(req.params.id);
    res.json(exercise);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.syncExercises = async (req, res) => {
  try {
    const response = await axios.get('https://api.api-ninjas.com/v1/exercises', {
      headers: { 'X-Api-Key': process.env.API_NINJAS_KEY }
    });
    const exercises = await Exercise.insertMany(response.data);
    res.json({ message: 'Exercises synced', count: exercises.length });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
