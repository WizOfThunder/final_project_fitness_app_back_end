const express = require('express');
const router = express.Router();
const adminController = require('./admin.controller');
const authMiddleware = require('../../middleware/auth.middleware');
const roleMiddleware = require('../../middleware/role.middleware');

router.get('/stats', authMiddleware, roleMiddleware('admin'), adminController.getStats);
router.get('/transactions', authMiddleware, roleMiddleware('admin'), adminController.getTransactions);
router.get('/transactions/:transactionId', authMiddleware, roleMiddleware('admin'), adminController.getTransactionDetail);

module.exports = router;
