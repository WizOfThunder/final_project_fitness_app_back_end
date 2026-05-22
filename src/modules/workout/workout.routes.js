const express = require('express');
const router = express.Router();
const workoutController = require('./workout.controller');
const authMiddleware = require('../../middleware/auth.middleware');
const roleMiddleware = require('../../middleware/role.middleware');
const certificationMiddleware = require('../../middleware/certification.middleware');

router.get('/my-plan', authMiddleware, workoutController.getMyPlan);
router.get('/trainer/clients', authMiddleware, roleMiddleware('trainer'), certificationMiddleware, workoutController.getTrainerClients);
router.get('/trainer/member/:userId', authMiddleware, roleMiddleware('trainer'), certificationMiddleware, workoutController.getMemberPlan);
router.post('/trainer/assign', authMiddleware, roleMiddleware('trainer'), certificationMiddleware, workoutController.assignPlan);
router.get('/:id', authMiddleware, workoutController.getPlan);
router.patch('/item/:itemId/toggle', authMiddleware, workoutController.toggleItem);
router.delete('/:id', authMiddleware, workoutController.deletePlan);

module.exports = router;
