const express = require('express');
const router = express.Router();
const aiController = require('./ai.controller');
const authMiddleware = require('../../middleware/auth.middleware');

router.post('/generate-workout', authMiddleware, aiController.generateWorkout);
router.post('/generate-diet', authMiddleware, aiController.generateDiet);
router.post('/regenerate-workout', authMiddleware, aiController.regenerateWorkout);
router.post('/regenerate-diet', authMiddleware, aiController.regenerateDiet);
router.get('/generation-status/:jobId', authMiddleware, aiController.getGenerationStatus);
router.get('/my-workout', authMiddleware, aiController.getMyWorkout);
router.get('/my-diet', authMiddleware, aiController.getMyDiet);

module.exports = router;
