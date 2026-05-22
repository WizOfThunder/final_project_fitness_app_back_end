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
const paymentRoutes = require('./modules/payment/payment.routes');
const chatRoutes = require('./modules/chat/chat.routes');
const notificationRoutes = require('./modules/notification/notification.routes');

const announcementRoutes = require('./modules/announcement/announcement.routes');
const sessionRoutes = require('./modules/session/session.routes');

const trainerRoutes = require('./modules/trainer/trainer.routes');
const recipeRoutes = require('./modules/recipe/recipe.routes');
const adminRoutes = require('./modules/admin/admin.routes');
const gymsRoutes = require('./modules/gyms/gyms.routes');

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
router.use('/payment', paymentRoutes);
router.use('/chat', chatRoutes);
router.use('/notification', notificationRoutes);
router.use('/announcements', announcementRoutes);
router.use('/sessions', sessionRoutes);
router.use('/trainers', trainerRoutes);
router.use('/recipes', recipeRoutes);
router.use('/admin', adminRoutes);
router.use('/gyms', gymsRoutes);

module.exports = router;
