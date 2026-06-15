const Exercise = require('./exercise.model');
const axios = require('axios');

exports.getExercises = async (req, res) => {
  try {
    const { name, type, muscle, equipment, difficulty, order } = req.query;
    const exercises = await Exercise.filter({ name, type, muscle, equipment, difficulty, order });
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
    const { name, type, muscle, difficulty, equipment } = req.body;
    const allMuscles = ['abdominals', 'abductors', 'adductors', 'biceps', 'calves', 'chest', 'forearms', 'glutes', 'hamstrings', 'lats', 'lower_back', 'middle_back', 'neck', 'quadriceps', 'traps', 'triceps'];
    const allTypes = ['cardio', 'olympic_weightlifting', 'plyometrics', 'powerlifting', 'strength', 'stretching', 'strongman'];

    const isFiltered = name || type || muscle || difficulty || equipment;
    const targets = isFiltered
      ? [{ name, type, muscle, difficulty, equipment }]
      : [
          ...allMuscles.map(m => ({ muscle: m })),
          ...allTypes.map(t => ({ type: t }))
        ];

    let allExercises = [];
    for (const params of targets) {
      const cleanParams = Object.fromEntries(Object.entries(params).filter(([, v]) => v != null));
      const response = await axios.get('https://api.api-ninjas.com/v1/exercises', {
        headers: { 'X-Api-Key': process.env.API_NINJAS_KEY },
        params: cleanParams
      });
      if (response.data && response.data.length > 0) {
        allExercises = allExercises.concat(response.data);
      }
    }

    const uniqueExercises = [];
    const seen = new Set();
    for (const exercise of allExercises) {
      const key = exercise.name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        uniqueExercises.push({
          name: exercise.name,
          type: exercise.type || null,
          muscle: exercise.muscle,
          equipment: Array.isArray(exercise.equipments) ? exercise.equipments.join(', ') : (exercise.equipments || null),
          difficulty: exercise.difficulty,
          instructions: exercise.instructions || null,
          safety_info: exercise.safety_info || null,
          youtube_url: null
        });
      }
    }

    const existing = await Exercise.find();
    const existingNames = new Set(existing.map(e => e.name.toLowerCase()));

    const toInsert = uniqueExercises.filter(e => !existingNames.has(e.name.toLowerCase()));
    if (toInsert.length > 0) await Exercise.insertMany(toInsert);

    res.json({ message: 'Exercises synced successfully', added: toInsert.length, skipped: uniqueExercises.length - toInsert.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.syncYoutubeUrls = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Exercise name is required' });

    const exercise = await Exercise.findOne({ name });
    if (!exercise) return res.status(404).json({ error: 'Exercise not found' });

    const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        q: `proper ${name} exercise tutorial`,
        type: 'video',
        maxResults: 3,
        videoDuration: 'medium',
        key: process.env.YOUTUBE_API_KEY
      }
    });

    const items = response.data.items;
    if (!items || items.length === 0) return res.status(404).json({ error: 'No YouTube results found' });

    const results = items.map(item => ({
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      url: `https://www.youtube.com/watch?v=${item.id.videoId}`
    }));

    res.json({ exercise_id: exercise.id, exercise_name: exercise.name, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.createExercise = async (req, res) => {
  try {
    const { name, type, muscle, equipment, difficulty, instructions, safety_info, youtube_url } = req.body;
    if (!name || !muscle || !difficulty) return res.status(400).json({ error: 'name, muscle and difficulty are required' });
    const exercise = await Exercise.create({ name, type: type || null, muscle, equipment: equipment || null, difficulty, instructions: instructions || null, safety_info: safety_info || null, youtube_url: youtube_url || null });
    res.status(201).json(exercise);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.updateExercise = async (req, res) => {
  try {
    const allowed = ['name', 'type', 'muscle', 'equipment', 'difficulty', 'instructions', 'safety_info', 'youtube_url'];
    const data = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
    const exercise = await Exercise.findByIdAndUpdate(req.params.id, data);
    if (!exercise) return res.status(404).json({ error: 'Exercise not found' });
    res.json(exercise);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.deleteExercise = async (req, res) => {
  try {
    const { pool } = require('../../config/db');
    const [result] = await pool.query('DELETE FROM exercises WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Exercise not found' });
    res.json({ message: 'Exercise deleted' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.setYoutubeUrl = async (req, res) => {
  try {
    const { youtube_url } = req.body;
    if (!youtube_url) return res.status(400).json({ error: 'youtube_url is required' });

    const exercise = await Exercise.findByIdAndUpdate(req.params.id, { youtube_url });
    if (!exercise) return res.status(404).json({ error: 'Exercise not found' });

    res.json({ message: 'YouTube URL updated', exercise_id: req.params.id, youtube_url });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
