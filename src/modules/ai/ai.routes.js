const express = require('express');
const router = express.Router();
const aiController = require('./ai.controller');
const authMiddleware = require('../../middleware/auth.middleware');

router.post('/generate-workout', authMiddleware, aiController.generateWorkout);
router.post('/generate-diet', authMiddleware, aiController.generateDiet);

module.exports = router;
