const express = require('express');
const router = express.Router();

const authRoutes = require('./modules/auth/auth.routes');
const userRoutes = require('./modules/users/user.routes');
const exerciseRoutes = require('./modules/exercises/exercise.routes');
const aiRoutes = require('./modules/ai/ai.routes');
const workoutRoutes = require('./modules/workout/workout.routes');
const validationRoutes = require('./modules/validation/validation.routes');
const challengeRoutes = require('./modules/challenge/challenge.routes');
const achievementRoutes = require('./modules/achievement/achievement.routes');
const activityRoutes = require('./modules/users/activity.routes');
const rankingRoutes = require('./modules/users/ranking.routes');

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/exercises', exerciseRoutes);
router.use('/ai', aiRoutes);
router.use('/workout', workoutRoutes);
router.use('/validation', validationRoutes);
router.use('/challenges', challengeRoutes);
router.use('/achievements', achievementRoutes);
router.use('/activity', activityRoutes);
router.use('/ranking', rankingRoutes);

module.exports = router;
