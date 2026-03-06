const express = require('express');
const router = express.Router();
const workoutController = require('./workout.controller');
const authMiddleware = require('../../middleware/auth.middleware');

router.get('/my-plan', authMiddleware, workoutController.getMyPlan);
router.get('/:id', authMiddleware, workoutController.getPlan);
router.delete('/:id', authMiddleware, workoutController.deletePlan);

module.exports = router;
