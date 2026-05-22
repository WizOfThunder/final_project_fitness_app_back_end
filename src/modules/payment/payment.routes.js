const express = require('express');
const router = express.Router();
const paymentController = require('./payment.controller');
const authMiddleware = require('../../middleware/auth.middleware');

router.post('/create-transaction', authMiddleware, paymentController.createTransaction);
router.post('/midtrans-notification', paymentController.handleNotification);
router.post('/simulate-payment', authMiddleware, paymentController.simulatePayment);
router.get('/status/:order_id', authMiddleware, paymentController.getPaymentStatus);
router.get('/my-payments', authMiddleware, paymentController.getMyPayments);

module.exports = router;
