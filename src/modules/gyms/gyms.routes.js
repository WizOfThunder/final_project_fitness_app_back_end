const express = require('express');
const router = express.Router();
const axios = require('axios');

router.get('/nearby', async (req, res) => {
  try {
    const { latitude, longitude } = req.query;
    if (!latitude || !longitude) {
      return res.status(400).json({ error: 'latitude and longitude are required' });
    }

    const query = `[out:json];node["leisure"="fitness_centre"](around:5000,${latitude},${longitude});out;`;

    const response = await axios.post(
      'https://overpass-api.de/api/interpreter',
      `data=${encodeURIComponent(query)}`,
      {
        headers: {
          'User-Agent': 'curl/7.68.0',
          'Accept': '*/*',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    const gyms = response.data.elements.map(item => ({
      id: item.id.toString(),
      name: item.tags?.name || 'Gym',
      latitude: item.lat,
      longitude: item.lon,
    }));

    res.json(gyms);
  } catch (error) {
    console.error('Gyms API error:', error.message, error.response?.data);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
