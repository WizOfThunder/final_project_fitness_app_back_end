const express = require('express');
const router = express.Router();
const validationController = require('./validation.controller');
const authMiddleware = require('../../middleware/auth.middleware');
const roleMiddleware = require('../../middleware/role.middleware');

router.get('/pending', authMiddleware, roleMiddleware('admin'), validationController.getPending);
router.put('/:plan_id', authMiddleware, roleMiddleware('admin'), validationController.validatePlan);

module.exports = router;
