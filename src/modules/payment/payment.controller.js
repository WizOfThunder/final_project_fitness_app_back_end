const Payment = require('./payment.model');
const { TrainerHire } = require('../trainer/trainer.model');
const { sendPushNotification } = require('../notification/notification.service');
const { saveNotification } = require('../notification/notification.helper');
const { pool } = require('../../config/db');
const axios = require('axios');
const {
  MIDTRANS_BASE,
  getMidtransAuth,
  getMidtransTransactionStatus,
} = require('../../config/midtrans');

function mapMidtransPaymentStatus(transactionStatus, fraudStatus) {
  if (transactionStatus === 'capture' && fraudStatus === 'accept') return 'settlement';
  if (transactionStatus === 'settlement') return 'settlement';
  if (transactionStatus === 'refund') return 'refunded';
  if (transactionStatus === 'partial_refund') return 'partial_refund';
  if (transactionStatus === 'expire') return 'expired';
  if (['cancel', 'deny'].includes(transactionStatus)) return 'failed';
  return 'pending';
}

function parseDateOnly(value) {
  if (!value) return null;

  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateLabel(value) {
  const date = parseDateOnly(value);
  if (!date) {
    return String(value || '');
  }

  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

async function handleSettledTrainerHire(orderId) {
  const [[hirePost]] = await pool.query(
    'SELECT tp.visibility FROM trainer_hires th JOIN trainer_posts tp ON tp.id = th.post_id WHERE th.payment_order_id = ?',
    [orderId]
  );
  if (!hirePost) return;

  if (hirePost.visibility === 'public') {
    const hire = await TrainerHire.activateFromPayment(orderId);
    if (hire) {
      await notifyPublicHireActivated(hire);
    }
    return;
  }

  const deadline = await TrainerHire.setPendingTrainerResponse(orderId);
  if (deadline) {
    await notifyTrainerOfHire(orderId, deadline).catch(err => console.error('[Payment] Failed to notify trainer:', err.message));
  }
}

exports.createTransaction = async (req, res) => {
  try {
    const { amount, item_details } = req.body;
    const orderId = 'order-' + Date.now();

    console.log('[Payment] createTransaction called');
    console.log('[Payment] orderId:', orderId);
    console.log('[Payment] amount:', amount);

    const payload = {
      transaction_details: { order_id: orderId, gross_amount: amount },
      credit_card: { secure: true },
      customer_details: { email: req.user.email || 'customer@example.com' }
    };
    if (item_details) payload.item_details = item_details;

    console.log('[Payment] Calling POST /snap/v1/transactions...');
    const { data } = await axios.post(
      `${MIDTRANS_BASE}/snap/v1/transactions`,
      payload,
      getMidtransAuth()
    );
    console.log('[Payment] Snap create succeeded, token:', data.token?.substring(0, 20) + '...');

    await Payment.create({
      order_id: orderId,
      user_id: req.user.id,
      amount,
      snap_token: data.token,
      snap_redirect_url: data.redirect_url,
      status: 'pending'
    });

    res.json({ order_id: orderId, token: data.token, redirect_url: data.redirect_url });
  } catch (error) {
    console.error('[Payment] createTransaction failed:', error.message);
    if (error.response) console.error('[Payment] Midtrans response status:', error.response.status, 'data:', JSON.stringify(error.response.data));
    res.status(500).json({ error: error.message });
  }
};

exports.handleNotification = async (req, res) => {
  try {
    const { order_id } = req.body;
    console.log('[Payment] handleNotification called, order_id:', order_id);

    const notification = await getMidtransTransactionStatus(order_id);
    console.log('[Payment] status fetched:', notification.transaction_status, 'fraud:', notification.fraud_status);
    const { transaction_status, fraud_status, transaction_id, payment_type } = notification;

    const mappedStatus = mapMidtransPaymentStatus(
      transaction_status,
      fraud_status,
    );

    const payment = await Payment.findOneAndUpdate(
      { order_id },
      { status: mappedStatus, transaction_id, payment_type, updated_at: new Date() }
    );
    const status = payment?.status || mappedStatus;

    if (order_id.startsWith('hire-')) {
      if (status === 'settlement') {
        await handleSettledTrainerHire(order_id);
      } else if (['failed', 'expired', 'refunded', 'partial_refund'].includes(status)) {
        await TrainerHire.cancelPendingPayment(order_id);
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('[Payment] handleNotification failed:', error.message);
    if (error.response) console.error('[Payment] Midtrans status:', error.response.status, 'data:', JSON.stringify(error.response.data));
    res.status(500).json({ error: error.message });
  }
};

async function notifyPublicHireActivated(hire) {
  try {
    if (hire.flow === 'enrolled') {
      const startStr = formatDateLabel(hire.program_start_date);
      const mTitle = 'Enrollment Confirmed!';
      const mBody = `You're enrolled in "${hire.post_title}". The program starts on ${startStr}. Get ready!`;
      await saveNotification(hire.member_id, mTitle, mBody, 'trainer_hire');
      if (hire.member_fcm_token) {
        sendPushNotification(hire.member_fcm_token, mTitle, mBody, {type: 'trainer_enrolled', post_id: String(hire.post_id)})
          .catch(err => console.error('[Payment] FCM enrolled member failed:', err.message));
      }
      const tTitle = 'New Enrollment';
      const tBody = `${hire.member_name} enrolled in "${hire.post_title}". Program starts ${startStr}.`;
      await saveNotification(hire.trainer_id, tTitle, tBody, 'trainer_hire');
      if (hire.trainer_fcm_token) {
        sendPushNotification(hire.trainer_fcm_token, tTitle, tBody, {type: 'trainer_enrolled'})
          .catch(err => console.error('[Payment] FCM enrolled trainer failed:', err.message));
      }
    } else {
      const mTitle = 'Subscription Active!';
      const mBody = `Your subscription to "${hire.post_title}" is now active. Good luck!`;
      await saveNotification(hire.member_id, mTitle, mBody, 'trainer_hire');
      if (hire.member_fcm_token) {
        sendPushNotification(hire.member_fcm_token, mTitle, mBody, {type: 'trainer_hire_active'})
          .catch(err => console.error('[Payment] FCM active member failed:', err.message));
      }
      const tTitle = hire.post_closed ? 'New Client + Post Closed' : 'New Client Joined';
      const tBody = hire.post_closed
        ? `${hire.member_name} joined "${hire.post_title}". All slots are now filled — post has been closed.`
        : `${hire.member_name} joined your program "${hire.post_title}"!`;
      await saveNotification(hire.trainer_id, tTitle, tBody, 'trainer_hire');
      if (hire.trainer_fcm_token) {
        sendPushNotification(hire.trainer_fcm_token, tTitle, tBody, {type: 'trainer_hire_active'})
          .catch(err => console.error('[Payment] FCM active trainer failed:', err.message));
      }
    }
  } catch (err) {
    console.error('[Payment] notifyPublicHireActivated error:', err.message);
  }
}

async function notifyTrainerOfHire(order_id, deadline) {
  const [[hireInfo]] = await pool.query(
    `SELECT th.id, tp.title,
            trainer.id AS trainer_id, trainer.fcm_token AS trainer_fcm_token,
            member.name AS member_name
     FROM trainer_hires th
     JOIN trainer_posts tp ON tp.id = th.post_id
     JOIN users trainer ON trainer.id = tp.trainer_id
     JOIN users member ON member.id = th.member_id
     WHERE th.payment_order_id = ?`,
    [order_id]
  );
  if (!hireInfo) return;
  const deadlineStr = new Date(deadline).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Jakarta',
  });
  const title = 'New Hire Request';
  const body = `${hireInfo.member_name} wants to hire you for "${hireInfo.title}". Please accept or decline before ${deadlineStr} WIB.`;
  await saveNotification(hireInfo.trainer_id, title, body, 'trainer_hire');
  if (hireInfo.trainer_fcm_token) {
    sendPushNotification(hireInfo.trainer_fcm_token, title, body, {
      type: 'trainer_hire',
      hire_id: String(hireInfo.id),
    }).catch(err => console.error('[Payment] FCM to trainer failed:', err.message));
  }
}

exports.simulatePayment = async (req, res) => {
  try {
    const { order_id } = req.body;
    console.log('[Payment] simulatePayment called, order_id:', order_id);
    console.log('[Payment] serverKey present:', !!process.env.MIDTRANS_SERVER_KEY);
    console.log('[Payment] serverKey prefix:', process.env.MIDTRANS_SERVER_KEY?.substring(0, 15) + '...');
    console.log('[Payment] Calling POST /v2/' + order_id + '/settlement...');
    const simRes = await axios.post(
      `${MIDTRANS_BASE}/v2/${order_id}/settlement`,
      {},
      getMidtransAuth()
    );
    console.log('[Payment] simulatePayment succeeded, status:', simRes.status);
    const payment = await Payment.findOneAndUpdate({ order_id }, { status: 'settlement', updated_at: new Date() });
    if (order_id.startsWith('hire-') && payment?.status === 'settlement') {
      await handleSettledTrainerHire(order_id);
    }
    res.json({ message: 'Payment simulated successfully', order_id });
  } catch (error) {
    console.error('[Payment] simulatePayment failed:', error.message);
    if (error.response) console.error('[Payment] Midtrans status:', error.response.status, 'data:', JSON.stringify(error.response.data));
    res.status(500).json({ error: error.message });
  }
};

exports.getPaymentStatus = async (req, res) => {
  try {
    const payment = await Payment.findOne({ order_id: req.params.order_id });
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    res.json(payment);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getMyPayments = async (req, res) => {
  try {
    const payments = await Payment.find({ user_id: req.user.id });
    res.json(payments);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
