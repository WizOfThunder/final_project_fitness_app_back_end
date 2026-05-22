const { TrainerPost, TrainerHire, TrainerReview } = require('./trainer.model');
const Payment = require('../payment/payment.model');
const axios = require('axios');
const { saveNotification } = require('../notification/notification.helper');
const { sendPushNotification } = require('../notification/notification.service');
const { pool } = require('../../config/db');
const {
  MIDTRANS_BASE,
  getMidtransAuth,
  getMidtransTransactionStatus,
  reverseMidtransTransaction,
} = require('../../config/midtrans');

const toMinutes = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const slotsOverlap = (a, b) => {
  if (a.day !== b.day) return false;
  return toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end);
};
const findScheduleConflict = (newSlots, existingPosts, excludePostId) => {
  for (const post of existingPosts) {
    if (post.id === excludePostId) continue;
    const existing = typeof post.schedule === 'string' ? JSON.parse(post.schedule) : (post.schedule || []);
    for (const ns of newSlots) {
      for (const es of existing) {
        if (slotsOverlap(ns, es)) {
          return `Schedule conflict: ${ns.day} ${ns.start}–${ns.end} overlaps with your post "${post.title}" (${es.start}–${es.end}). Please adjust the time.`;
        }
      }
    }
  }
  return null;
};

const WIB_CURRENT_DATE_SQL = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date`;
const WIB_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jakarta',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function formatWibDate(date) {
  const parts = Object.fromEntries(
    WIB_DATE_FORMATTER.formatToParts(date).map(part => [part.type, part.value]),
  );

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getDateOnlyString(value) {
  if (!value) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatWibDate(value);
  }

  const stringValue = String(value);
  const directMatch = stringValue.match(/^(\d{4}-\d{2}-\d{2})/);
  if (directMatch) return directMatch[1];

  const parsed = new Date(stringValue);
  if (!Number.isNaN(parsed.getTime())) {
    return formatWibDate(parsed);
  }

  return stringValue;
}

function getCurrentWibDateString() {
  return formatWibDate(new Date());
}

function mapMidtransPaymentStatus(transactionStatus, fraudStatus) {
  if (transactionStatus === 'capture' && fraudStatus === 'accept') {
    return 'settlement';
  }
  if (transactionStatus === 'settlement') {
    return 'settlement';
  }
  if (transactionStatus === 'refund') {
    return 'refunded';
  }
  if (transactionStatus === 'partial_refund') {
    return 'partial_refund';
  }
  if (transactionStatus === 'expire') {
    return 'expired';
  }
  if (['cancel', 'deny'].includes(transactionStatus)) {
    return 'failed';
  }
  return 'pending';
}

async function reconcilePendingTrainerHires(trainerId) {
  const [pendingHires] = await pool.query(
    `SELECT th.payment_order_id, tp.visibility
     FROM trainer_hires th
     JOIN trainer_posts tp ON tp.id = th.post_id
     WHERE tp.trainer_id = ?
       AND th.status = 'pending_payment'
       AND th.payment_order_id IS NOT NULL`,
    [trainerId],
  );

  for (const hire of pendingHires) {
    let payment = await Payment.findOne({order_id: hire.payment_order_id});
    let paymentStatus = payment?.status || 'pending';

    if (paymentStatus === 'pending') {
      try {
        const midtransStatus = await getMidtransTransactionStatus(
          hire.payment_order_id,
        );
        paymentStatus = mapMidtransPaymentStatus(
          midtransStatus.transaction_status,
          midtransStatus.fraud_status,
        );

        await Payment.findOneAndUpdate(
          {order_id: hire.payment_order_id},
          {
            status: paymentStatus,
            transaction_id: midtransStatus.transaction_id,
            payment_type: midtransStatus.payment_type,
            updated_at: new Date(),
          },
        );
      } catch (error) {
        console.error(
          '[Trainer] reconcilePendingTrainerHires Midtrans lookup failed:',
          error.message,
        );
      }
    }

    if (paymentStatus === 'settlement') {
      if (hire.visibility === 'public') {
        await TrainerHire.activateFromPayment(hire.payment_order_id);
      } else {
        await TrainerHire.setPendingTrainerResponse(hire.payment_order_id);
      }
      continue;
    }

    if (['failed', 'expired'].includes(paymentStatus)) {
      await TrainerHire.cancelPendingPayment(hire.payment_order_id);
    }
  }
}

async function reconcileReadyEnrolledHires(filters = {}) {
  await TrainerHire.activateReadyEnrolledHires(filters);
}

async function getTrainerPostState(postId, trainerId) {
  const [[post]] = await pool.query(
    `SELECT tp.id, tp.trainer_id, tp.is_active, tp.deactivated_by, tp.schedule,
            (
              SELECT COUNT(*)
              FROM trainer_hires th
              WHERE th.post_id = tp.id
                AND th.status IN ('pending_payment','pending_approval','enrolled','active')
            ) AS current_client_count
     FROM trainer_posts tp
     WHERE tp.id = ? AND tp.trainer_id = ?`,
    [postId, trainerId],
  );

  return post || null;
}

function postBlocksSchedule(post) {
  return !!post?.is_active || Number(post?.current_client_count || 0) > 0;
}

async function findBlockingScheduleConflict(trainerId, newSlots, excludePostId) {
  const [existingPosts] = await pool.query(
    `SELECT tp.id, tp.title, tp.schedule, tp.is_active,
            (
              SELECT COUNT(*)
              FROM trainer_hires th
              WHERE th.post_id = tp.id
                AND th.status IN ('pending_payment','pending_approval','enrolled','active')
            ) AS current_client_count
     FROM trainer_posts tp
     WHERE tp.trainer_id = ? AND tp.schedule IS NOT NULL`,
    [trainerId],
  );

  const blockingPosts = existingPosts.filter(post => postBlocksSchedule(post));
  return findScheduleConflict(newSlots, blockingPosts, excludePostId);
}

const notifyHireEndedByAgreement = async hireInfo => {
  const memberTitle = 'Subscription Ended';
  const memberBody = `Your subscription to "${hireInfo.post_title}" has ended by mutual agreement. You can now leave a review.`;
  await saveNotification(hireInfo.member_id, memberTitle, memberBody, 'trainer_hire');
  if (hireInfo.member_fcm) {
    sendPushNotification(hireInfo.member_fcm, memberTitle, memberBody, { type: 'hire_ended' }).catch(() => {});
  }

  const trainerTitle = 'Subscription Ended';
  const trainerBody = `Your subscription with ${hireInfo.member_name} for "${hireInfo.post_title}" has ended by mutual agreement.`;
  await saveNotification(hireInfo.trainer_id, trainerTitle, trainerBody, 'trainer_hire', {
    screen: 'TrainerHireManagement',
    params: { initialTab: 'past', hireId: hireInfo.id },
  });
  if (hireInfo.trainer_fcm) {
    sendPushNotification(hireInfo.trainer_fcm, trainerTitle, trainerBody, { type: 'hire_ended' }).catch(() => {});
  }
};

exports.togglePostActive = async (req, res) => {
  try {
    const [[post]] = await pool.query(
      `SELECT tp.is_active, tp.title, u.id AS trainer_id, u.fcm_token, u.name AS trainer_name
       FROM trainer_posts tp JOIN users u ON u.id = tp.trainer_id WHERE tp.id = ?`,
      [req.params.id]
    );
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const newActive = !post.is_active;
    await pool.query(
      'UPDATE trainer_posts SET is_active = ?, deactivated_by = ? WHERE id = ?',
      [newActive, newActive ? null : 'admin', req.params.id]
    );

    const { note } = req.body;
    const title = newActive ? 'Post Reactivated' : 'Post Deactivated';
    const baseBody = newActive
      ? `Your post "${post.title}" has been reactivated by admin.`
      : `Your post "${post.title}" has been deactivated by admin.`;
    const body = note ? `${baseBody} Note: ${note}` : baseBody;

    await saveNotification(post.trainer_id, title, body, 'general', {
      screen: 'ManagePosts',
      params: {},
      intent: 'post_status',
      post_id: Number(req.params.id),
    });
    if (post.fcm_token) {
      const { sendPushNotification } = require('../notification/notification.service');
      sendPushNotification(post.fcm_token, title, body, { type: 'post_status' }).catch(() => {});
    }

    res.json({ is_active: newActive });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getAllPosts = async (req, res) => {
  try {
    const posts = await TrainerPost.findAll(req.user?.id);
    res.json(posts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getDashboardStats = async (req, res) => {
  try {
    const trainerId = req.user.id;

    await reconcilePendingTrainerHires(trainerId);
    await reconcileReadyEnrolledHires({ trainerId });

    const [[{ total_clients }]] = await pool.query(
       `SELECT COUNT(*) AS total_clients FROM trainer_hires th
       JOIN trainer_posts tp ON tp.id = th.post_id
       WHERE tp.trainer_id = ? AND th.status IN ('active', 'enrolled')`, [trainerId]
    );

    const [[{ new_requests }]] = await pool.query(
      `SELECT COUNT(*) AS new_requests FROM trainer_hires th
       JOIN trainer_posts tp ON tp.id = th.post_id
       WHERE tp.trainer_id = ?
         AND ((th.status = 'pending_payment' AND th.trainer_response_deadline IS NOT NULL)
           OR th.status = 'pending_approval')`, [trainerId]
    );

    const [[{ confirmed_today }]] = await pool.query(
      `SELECT COUNT(*) AS confirmed_today FROM hire_sessions hs
       JOIN trainer_hires th ON th.id = hs.hire_id
       JOIN trainer_posts tp ON tp.id = th.post_id
       WHERE tp.trainer_id = ? AND hs.status = 'confirmed'
          AND (hs.member_confirmed_at AT TIME ZONE 'Asia/Jakarta')::date = ${WIB_CURRENT_DATE_SQL}`,
      [trainerId]
    );

    const [[{ scheduled_today }]] = await pool.query(
      `SELECT COUNT(*) AS scheduled_today FROM hire_sessions hs
       JOIN trainer_hires th ON th.id = hs.hire_id
       JOIN trainer_posts tp ON tp.id = th.post_id
        WHERE tp.trainer_id = ? AND hs.scheduled_date = ${WIB_CURRENT_DATE_SQL}`,
      [trainerId]
    );

    const [[{ unread_messages }]] = await pool.query(
      `SELECT COUNT(*) AS unread_messages FROM chats
       WHERE receiver_id = ? AND is_read = FALSE`, [trainerId]
    );

    const [clientActivity] = await pool.query(
      `SELECT hs.id, hs.status, hs.scheduled_date, hs.scheduled_day, hs.scheduled_start,
              hs.member_confirmed_at, hs.trainer_started_at,
              u.name AS member_name, tp.title AS post_title
       FROM hire_sessions hs
       JOIN trainer_hires th ON th.id = hs.hire_id
       JOIN trainer_posts tp ON tp.id = th.post_id
       JOIN users u ON u.id = th.member_id
       WHERE tp.trainer_id = ? AND hs.status IN ('confirmed','missed')
       ORDER BY COALESCE(hs.member_confirmed_at, hs.scheduled_date) DESC
       LIMIT 10`, [trainerId]
    );

    res.json({
      total_clients: Number(total_clients),
      new_requests: Number(new_requests),
      confirmed_today: Number(confirmed_today),
      scheduled_today: Number(scheduled_today),
      unread_messages: Number(unread_messages),
      client_activity: clientActivity,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getAllPostsAdmin = async (req, res) => {
  try {
    const posts = await TrainerPost.findAllAdmin();
    res.json(posts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getPost = async (req, res) => {
  try {
    const post = await TrainerPost.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const reviews = await TrainerReview.findByPost(req.params.id);
    res.json({ ...post, reviews });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.createPost = async (req, res) => {
  try {
    const { title, description, focus_areas, services, price, is_active, session_type, location, visibility, max_slots, schedule, enrollment_deadline, program_start_date } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    if (!price || price <= 0) return res.status(400).json({ error: 'Price must be a positive number' });
    if (session_type === 'offline' && !location) return res.status(400).json({ error: 'Location is required for offline sessions' });

    const nextIsActive = is_active !== undefined ? !!is_active : true;

    if (nextIsActive && Array.isArray(schedule) && schedule.length > 0) {
      const conflict = await findBlockingScheduleConflict(
        req.user.id,
        schedule,
        null,
      );
      if (conflict) return res.status(400).json({ error: conflict });
    }

    const today = getCurrentWibDateString();
    if (enrollment_deadline && visibility === 'public') {
      if (getDateOnlyString(enrollment_deadline) < today)
        return res.status(400).json({ error: 'Enrollment deadline must be today or in the future' });
    }
    if (program_start_date && visibility === 'public') {
      if (getDateOnlyString(program_start_date) < today)
        return res.status(400).json({ error: 'Program start date must be today or in the future' });
      if (enrollment_deadline && getDateOnlyString(program_start_date) <= getDateOnlyString(enrollment_deadline))
        return res.status(400).json({ error: 'Program start date must be after the enrollment deadline' });
    }

    const post = await TrainerPost.create({
      trainer_id: req.user.id, title, description, focus_areas, services, price,
      is_active: nextIsActive,
      session_type: session_type || 'online',
      location: location || null,
      visibility: visibility || 'public',
      max_slots: visibility === 'private' ? 1 : (max_slots || null),
      schedule: schedule ? JSON.stringify(schedule) : null,
      enrollment_deadline: visibility === 'public' ? (enrollment_deadline || null) : null,
      program_start_date: visibility === 'public' ? (program_start_date || null) : null,
    });
    res.status(201).json(post);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.updatePost = async (req, res) => {
  try {
    const postState = await getTrainerPostState(req.params.id, req.user.id);
    if (!postState) {
      return res.status(404).json({ error: 'Post not found or not yours' });
    }

    const currentClientCount = Number(postState.current_client_count || 0);
    const definedKeys = Object.keys(req.body).filter(
      key => req.body[key] !== undefined,
    );
    const isToggleOnly =
      definedKeys.length === 1 && definedKeys.includes('is_active');

    if (currentClientCount > 0) {
      if (!isToggleOnly) {
        return res.status(400).json({
          error: 'Cannot edit a post that currently has clients.',
        });
      }

      if (req.body.is_active === true && !postState.is_active) {
        return res.status(400).json({
          error: 'Cannot activate a post that currently has clients.',
        });
      }
    }

    const { title, description, focus_areas, services, price, is_active, session_type, location, visibility, max_slots, schedule, enrollment_deadline, program_start_date } = req.body;
    if (session_type === 'offline' && !location) return res.status(400).json({ error: 'Location is required for offline sessions' });

    const nextIsActive =
      is_active !== undefined ? !!is_active : !!postState.is_active;
    const scheduleToValidate = Array.isArray(schedule)
      ? schedule
      : postState.schedule
      ? JSON.parse(postState.schedule)
      : [];
    const postWillBlockSchedule = nextIsActive || currentClientCount > 0;

    if (postWillBlockSchedule && scheduleToValidate.length > 0) {
      const conflict = await findBlockingScheduleConflict(
        req.user.id,
        scheduleToValidate,
        Number(req.params.id),
      );
      if (conflict) return res.status(400).json({ error: conflict });
    }

    if (visibility === 'public') {
      const today = getCurrentWibDateString();
      if (enrollment_deadline && getDateOnlyString(enrollment_deadline) < today)
        return res.status(400).json({ error: 'Enrollment deadline must be today or in the future' });
      if (program_start_date && getDateOnlyString(program_start_date) < today)
        return res.status(400).json({ error: 'Program start date must be today or in the future' });
      if (program_start_date && enrollment_deadline && getDateOnlyString(program_start_date) <= getDateOnlyString(enrollment_deadline))
        return res.status(400).json({ error: 'Program start date must be after the enrollment deadline' });
    }

    // Only include defined fields so partial updates (e.g. toggle active) don't null out other columns
    const data = {};
    if (title !== undefined) data.title = title;
    if (description !== undefined) data.description = description;
    if (focus_areas !== undefined) data.focus_areas = focus_areas;
    if (services !== undefined) data.services = services;
    if (price !== undefined) data.price = price;
    if (is_active !== undefined) {
      data.is_active = is_active;
      data.deactivated_by = is_active ? null : 'trainer';
    }
    if (session_type !== undefined) data.session_type = session_type;
    if (location !== undefined) data.location = location || null;
    if (visibility !== undefined) data.visibility = visibility;
    if (max_slots !== undefined) data.max_slots = visibility === 'private' ? 1 : (max_slots || null);
    if (schedule !== undefined) data.schedule = JSON.stringify(schedule);
    if (visibility === 'public') {
      if (enrollment_deadline !== undefined) data.enrollment_deadline = enrollment_deadline || null;
      if (program_start_date !== undefined) data.program_start_date = program_start_date || null;
    } else if (visibility === 'private') {
      data.enrollment_deadline = null;
      data.program_start_date = null;
    }
    data.updated_at = new Date();

    const updated = await TrainerPost.update(req.params.id, req.user.id, data);
    if (!updated) return res.status(404).json({ error: 'Post not found or not yours' });
    res.json({ message: 'Post updated' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.deletePost = async (req, res) => {
  try {
    const postState = await getTrainerPostState(req.params.id, req.user.id);
    if (!postState) {
      return res.status(404).json({ error: 'Post not found or not yours' });
    }

    if (Number(postState.current_client_count || 0) > 0) {
      return res.status(400).json({
        error: 'Cannot delete a post that currently has clients.',
      });
    }

    const deleted = await TrainerPost.delete(req.params.id, req.user.id);
    if (!deleted) return res.status(404).json({ error: 'Post not found or not yours' });
    res.json({ message: 'Post deleted' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.hireTrainer = async (req, res) => {
  try {
    const post = await TrainerPost.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (!post.is_active) return res.status(400).json({ error: 'This trainer is not available' });

    // Check if member already has an active/pending hire for this post
    const [existingHire] = await require('../../config/db').pool.query(
      "SELECT id FROM trainer_hires WHERE member_id = ? AND post_id = ? AND status IN ('pending_payment','pending_approval','enrolled','active')",
      [req.user.id, post.id]
    );
    if (existingHire.length > 0) return res.status(400).json({ error: 'You already have an active or pending hire for this post' });

    // Enforce one pending or active hire per member globally
    const [activeGlobal] = await require('../../config/db').pool.query(
      "SELECT id, status FROM trainer_hires WHERE member_id = ? AND status IN ('pending_payment','pending_approval','enrolled','active') LIMIT 1",
      [req.user.id]
    );
    if (activeGlobal.length > 0) {
      const message = ['pending_payment', 'pending_approval'].includes(activeGlobal[0].status)
        ? 'You already have a pending trainer hire. Complete or resolve it before hiring another trainer.'
        : 'You already have an active subscription. End it before hiring a new trainer.';
      return res.status(400).json({ error: message });
    }

    // Check enrollment deadline
    if (post.enrollment_deadline && getDateOnlyString(post.enrollment_deadline) < getCurrentWibDateString()) {
      return res.status(400).json({ error: 'Enrollment for this post has closed' });
    }

    // Check slot availability
    if (post.max_slots) {
      const [activeHires] = await require('../../config/db').pool.query(
        `SELECT COUNT(*) as count FROM trainer_hires
         WHERE post_id = ?
           AND ((status = 'pending_payment' AND trainer_response_deadline IS NOT NULL)
             OR status IN ('pending_approval','enrolled','active'))`,
        [post.id]
      );
      if (activeHires[0].count >= post.max_slots) return res.status(400).json({ error: 'No slots available for this post' });
    }

    const orderId = `hire-${req.user.id}-${Date.now()}`;

    console.log('[Trainer] hireTrainer calling POST /snap/v1/transactions, orderId:', orderId, 'price:', post.price);
    const { data: transaction } = await axios.post(
      `${MIDTRANS_BASE}/snap/v1/transactions`,
      {
        transaction_details: { order_id: orderId, gross_amount: post.price },
        credit_card: { secure: true },
        customer_details: { email: req.user.email || 'member@example.com' },
        item_details: [{ id: `post-${post.id}`, price: post.price, quantity: 1, name: post.title }]
      },
      getMidtransAuth()
    );
    console.log('[Trainer] snap createTransaction succeeded, token:', transaction.token?.substring(0, 20) + '...');

    await Payment.create({
      order_id: orderId,
      user_id: req.user.id,
      amount: post.price,
      snap_token: transaction.token,
      snap_redirect_url: transaction.redirect_url,
      status: 'pending'
    });

    const hire = await TrainerHire.create({
      member_id: req.user.id,
      post_id: post.id,
      payment_order_id: orderId,
      start_date: new Date(),
      end_date: new Date(),  // will be set properly on accept
      status: 'pending_payment'
    });

    res.status(201).json({
      hire_id: hire.id,
      order_id: orderId,
      token: transaction.token,
      redirect_url: transaction.redirect_url
    });
  } catch (error) {
    console.error('[Trainer] hireTrainer snap.createTransaction failed:', error.message);
    if (error.response) console.error('[Trainer] Midtrans status:', error.response.status, 'data:', JSON.stringify(error.response.data));
    res.status(400).json({ error: error.message });
  }
};

exports.getMyHires = async (req, res) => {
  try {
    await reconcileReadyEnrolledHires({ memberId: req.user.id });
    const hires = await TrainerHire.findByMember(req.user.id);
    res.json(hires);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getPendingHires = async (req, res) => {
  try {
    await reconcilePendingTrainerHires(req.user.id);
    await reconcileReadyEnrolledHires({ trainerId: req.user.id });
    const hires = await TrainerHire.findPendingByTrainer(req.user.id);
    res.json(hires);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getActiveHires = async (req, res) => {
  try {
    await reconcilePendingTrainerHires(req.user.id);
    await reconcileReadyEnrolledHires({ trainerId: req.user.id });
    const hires = await TrainerHire.findActiveByTrainer(req.user.id);
    res.json(hires);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getPastHires = async (req, res) => {
  try {
    await reconcilePendingTrainerHires(req.user.id);
    await reconcileReadyEnrolledHires({ trainerId: req.user.id });
    const hires = await TrainerHire.findPastByTrainer(req.user.id);
    res.json(hires);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getMyPosts = async (req, res) => {
  try {
    await reconcilePendingTrainerHires(req.user.id);
    await reconcileReadyEnrolledHires({ trainerId: req.user.id });
    const [rows] = await pool.query(
      `SELECT tp.*,
              ROUND(AVG(tr.rating),1) AS avg_rating,
              COUNT(DISTINCT tr.id) AS review_count,
              COUNT(DISTINCT CASE WHEN th.status IN ('pending_payment','pending_approval','enrolled','active') THEN th.id END) AS current_slots,
              COUNT(DISTINCT CASE WHEN th.status IN ('pending_payment','pending_approval','enrolled','active') THEN th.id END) AS current_client_count
       FROM trainer_posts tp
       LEFT JOIN trainer_reviews tr ON tr.post_id = tp.id
       LEFT JOIN trainer_hires th ON th.post_id = tp.id
       WHERE tp.trainer_id = ?
       GROUP BY tp.id
       ORDER BY tp.created_at DESC`,
      [req.user.id]
    );

    const latestAdminMessageByPost = new Map();
    try {
      const [notifications] = await pool.query(
        `SELECT message, data
         FROM notifications
         WHERE user_id = ? AND type = 'general' AND data IS NOT NULL
         ORDER BY created_at DESC, id DESC`,
        [req.user.id],
      );

      for (const notification of notifications) {
        let payload = null;
        try {
          payload = notification.data ? JSON.parse(notification.data) : null;
        } catch (_) {
          payload = null;
        }

        const postId = Number(payload?.post_id);
        if (
          payload?.intent === 'post_status' &&
          Number.isFinite(postId) &&
          !latestAdminMessageByPost.has(postId)
        ) {
          latestAdminMessageByPost.set(postId, notification.message);
        }
      }
    } catch (messageError) {
      console.error(
        '[Trainer] Failed to load latest admin post messages:',
        messageError.message,
      );
    }

    res.json(
      rows.map(r => ({
        ...r,
        schedule: r.schedule ? JSON.parse(r.schedule) : [],
        latest_admin_message: latestAdminMessageByPost.get(Number(r.id)) || null,
      })),
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.acceptHire = async (req, res) => {
  try {
    const result = await TrainerHire.accept(req.params.hire_id, req.user.id);
    if (result === 'full') return res.status(400).json({ error: 'Cannot accept: post is already full.' });
    if (!result) return res.status(400).json({ error: 'Hire not found, not yours, or not awaiting trainer response' });

    // Notify member
    const [[hireInfo]] = await pool.query(
      `SELECT th.*, tp.title AS post_title, tp.id AS post_id,
              m.name AS member_name, m.fcm_token AS member_fcm,
              t.name AS trainer_name, t.fcm_token AS trainer_fcm
       FROM trainer_hires th
       JOIN trainer_posts tp ON tp.id = th.post_id
       JOIN users m ON m.id = th.member_id
       JOIN users t ON t.id = tp.trainer_id
       WHERE th.id = ?`, [req.params.hire_id]
    );
    if (hireInfo) {
      const mTitle = 'Hire Request Accepted!';
      const mBody = `${hireInfo.trainer_name} accepted your hire request for "${hireInfo.post_title}". Your subscription is now active!`;
      await saveNotification(hireInfo.member_id, mTitle, mBody, 'trainer_hire');
      if (hireInfo.member_fcm) sendPushNotification(hireInfo.member_fcm, mTitle, mBody, {type: 'trainer_hire_active', post_id: String(hireInfo.post_id)}).catch(() => {});

      // Notify trainer confirmation
      const tTitle = 'Hire Accepted';
      const tBody = `You accepted ${hireInfo.member_name}'s hire request for "${hireInfo.post_title}".`;
      await saveNotification(req.user.id, tTitle, tBody, 'trainer_hire');
    }

    res.json({ message: 'Hire accepted. Hire is now active.' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.declineHire = async (req, res) => {
  try {
    const hire = await TrainerHire.decline(req.params.hire_id, req.user.id);
    if (!hire) return res.status(400).json({ error: 'Hire not found, not yours, or not awaiting trainer response' });

    const reversal = await reverseMidtransTransaction(
      hire.payment_order_id,
      `Trainer declined hire ${hire.id}`
    );

    let paymentStatus = 'failed';
    if (reversal.action === 'refunded') paymentStatus = 'refunded';
    if (reversal.action === 'partial_refund') paymentStatus = 'partial_refund';
    if (reversal.action === 'expire') paymentStatus = 'expired';

    await Payment.findOneAndUpdate({ order_id: hire.payment_order_id }, { status: paymentStatus, updated_at: new Date() });
    await TrainerHire.markCancelled(hire.id);
    await TrainerPost.reactivateIfSystemClosed(hire.post_id);

    // Notify member
    const [[hireInfo]] = await pool.query(
      `SELECT th.*, tp.title AS post_title,
              m.name AS member_name, m.fcm_token AS member_fcm,
              t.name AS trainer_name
       FROM trainer_hires th
       JOIN trainer_posts tp ON tp.id = th.post_id
       JOIN users m ON m.id = th.member_id
       JOIN users t ON t.id = tp.trainer_id
       WHERE th.id = ?`, [req.params.hire_id]
    );
    if (hireInfo) {
      const mTitle = 'Hire Request Declined';
      const paymentOutcome = paymentStatus === 'refunded'
        ? 'Your payment has been refunded.'
        : 'Your payment has been reversed.';
      const mBody = `${hireInfo.trainer_name} declined your hire request for "${hireInfo.post_title}". ${paymentOutcome}`;
      await saveNotification(hireInfo.member_id, mTitle, mBody, 'trainer_hire');
      if (hireInfo.member_fcm) sendPushNotification(hireInfo.member_fcm, mTitle, mBody, {type: 'trainer_hire_declined'}).catch(() => {});
    }

    res.json({ message: paymentStatus === 'refunded' ? 'Hire declined and payment refunded.' : 'Hire declined and payment reversed.' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.endHire = async (req, res) => {
  try {
    const ended = await TrainerHire.end(req.params.hire_id, req.user.id);
    if (!ended) return res.status(404).json({ error: 'Hire not found, not yours, or not active' });

    const [[hireInfo]] = await pool.query(
      `SELECT th.*, th.post_id, tp.title AS post_title, tp.trainer_id,
              t.name AS trainer_name, t.fcm_token AS trainer_fcm,
              m.name AS member_name
       FROM trainer_hires th
       JOIN trainer_posts tp ON tp.id = th.post_id
       JOIN users t ON t.id = tp.trainer_id
       JOIN users m ON m.id = th.member_id
       WHERE th.id = ?`, [req.params.hire_id]
    );
    if (hireInfo) {
      // Notify member confirmation
      await saveNotification(req.user.id, 'Subscription Ended', `Your subscription to "${hireInfo.post_title}" has ended. You can now leave a review!`, 'trainer_hire');
      // Notify trainer
      const tTitle = 'Member Ended Subscription';
      const tBody = `${hireInfo.member_name} ended their subscription to "${hireInfo.post_title}".`;
      await saveNotification(hireInfo.trainer_id, tTitle, tBody, 'trainer_hire', {
        screen: 'TrainerHireManagement',
        params: { initialTab: 'past', hireId: hireInfo.id },
      });
      if (hireInfo.trainer_fcm) sendPushNotification(hireInfo.trainer_fcm, tTitle, tBody, {type: 'hire_ended'}).catch(() => {});

      // Auto-reactivate post if it was deactivated by the system (slots full) and enrollment hasn't expired
      await TrainerPost.reactivateIfSystemClosed(hireInfo.post_id);
    }

    res.json({ message: 'Hire ended. You can now leave a review.' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.requestHireEnd = async (req, res) => {
  try {
    const result = await TrainerHire.requestEnd(req.params.hire_id, req.user.id);
    if (result.code === 'not_found') return res.status(404).json({ error: 'Hire not found' });
    if (result.code === 'forbidden') return res.status(403).json({ error: 'Not your hire' });
    if (result.code === 'not_active') return res.status(400).json({ error: 'Only active subscriptions can be ended early' });
    if (result.code === 'already_requested') return res.status(400).json({ error: 'An end request is already pending for this subscription' });

    const hireInfo = result.hire;
    const requestedByMember = result.requesterRole === 'member';
    const receiverId = requestedByMember ? hireInfo.trainer_id : hireInfo.member_id;
    const receiverFcm = requestedByMember ? hireInfo.trainer_fcm : hireInfo.member_fcm;
    const requesterName = requestedByMember ? hireInfo.member_name : hireInfo.trainer_name;
    const title = 'Subscription End Request';
    const body = `${requesterName} requested to end the subscription for "${hireInfo.post_title}". Please accept or reject the request.`;

    await saveNotification(receiverId, title, body, 'trainer_hire');
    if (receiverFcm) {
      sendPushNotification(receiverFcm, title, body, { type: 'hire_end_request', hire_id: String(hireInfo.id) }).catch(() => {});
    }

    res.json({ message: 'End request sent.' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.respondHireEndRequest = async (req, res) => {
  try {
    const { action } = req.body;
    if (!['accept', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Action must be accept or reject' });
    }

    const result = await TrainerHire.respondEndRequest(req.params.hire_id, req.user.id, action);
    if (result.code === 'not_found') return res.status(404).json({ error: 'Hire not found' });
    if (result.code === 'forbidden') return res.status(403).json({ error: 'Not your hire' });
    if (result.code === 'own_request') return res.status(400).json({ error: 'You cannot respond to your own end request' });
    if (result.code === 'no_request') return res.status(400).json({ error: 'No end request is pending for this subscription' });
    if (result.code === 'not_active') return res.status(400).json({ error: 'This subscription is no longer active' });

    const hireInfo = result.hire;
    const requesterWasMember = hireInfo.early_end_requested_by === 'member';
    const requesterId = requesterWasMember ? hireInfo.member_id : hireInfo.trainer_id;
    const requesterFcm = requesterWasMember ? hireInfo.member_fcm : hireInfo.trainer_fcm;
    const responderName = result.responderRole === 'member' ? hireInfo.member_name : hireInfo.trainer_name;

    if (result.code === 'accepted') {
      await notifyHireEndedByAgreement(hireInfo);
      await TrainerPost.reactivateIfSystemClosed(hireInfo.post_id);
      return res.json({ message: 'Subscription ended by agreement.' });
    }

    const title = 'End Request Declined';
    const body = `${responderName} declined the request to end "${hireInfo.post_title}". Your subscription remains active.`;
    await saveNotification(requesterId, title, body, 'trainer_hire');
    if (requesterFcm) {
      sendPushNotification(requesterFcm, title, body, { type: 'hire_end_request_declined', hire_id: String(hireInfo.id) }).catch(() => {});
    }

    res.json({ message: 'End request rejected.' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.submitReview = async (req, res) => {
  try {
    const { rating, review } = req.body;
    if (!rating) return res.status(400).json({ error: 'Rating is required' });
    if (rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be between 1 and 5' });

    const hire = await TrainerHire.findById(req.params.hire_id);
    if (!hire) return res.status(404).json({ error: 'Hire not found' });
    if (hire.member_id !== req.user.id) return res.status(403).json({ error: 'Not your hire' });
    if (hire.status !== 'ended') return res.status(400).json({ error: 'Hire must be ended before reviewing' });

    const alreadyReviewed = await TrainerReview.existsByHire(hire.id);
    if (alreadyReviewed) return res.status(400).json({ error: 'You already reviewed this hire' });

    // Block reviews on disputed hires
    const { Dispute } = require('../session/session.model');
    const dispute = await Dispute.findOpenByHire(hire.id);
    if (dispute) {
      return res.status(400).json({ error: 'Cannot review while a dispute is open for this hire' });
    }

    // Check session attendance gate (minimum 50% of confirmed sessions)
    const { Session } = require('../session/session.model');
    const stats = await Session.getStats(hire.id);
    const total = Number(stats.total) || 0;
    const confirmed = Number(stats.confirmed) || 0;
    if (total > 0 && confirmed < Math.ceil(total * 0.5)) {
      return res.status(400).json({
        error: `You must attend at least 50% of sessions to leave a review. You attended ${confirmed} of ${total} sessions.`,
        sessions_total: total,
        sessions_confirmed: confirmed,
      });
    }

    const result = await TrainerReview.create({
      hire_id: hire.id,
      member_id: req.user.id,
      post_id: hire.post_id,
      rating,
      review: review || null,
      sessions_total: total,
      sessions_attended: confirmed,
    });

    // Notify trainer of new review
    const [[postInfo]] = await pool.query(
      `SELECT tp.trainer_id, tp.title, t.fcm_token AS trainer_fcm, m.name AS member_name
       FROM trainer_posts tp
       JOIN users t ON t.id = tp.trainer_id
       JOIN users m ON m.id = ?
       WHERE tp.id = ?`, [req.user.id, hire.post_id]
    );
    if (postInfo) {
      const stars = '⭐'.repeat(rating);
      const tTitle = 'New Review Received';
      const tBody = `${postInfo.member_name} left a ${stars} review on "${postInfo.title}".`;
      await saveNotification(postInfo.trainer_id, tTitle, tBody, 'trainer_hire', {
        screen: 'ManagePosts',
      });
      if (postInfo.trainer_fcm) sendPushNotification(postInfo.trainer_fcm, tTitle, tBody, {type: 'new_review', post_id: String(hire.post_id)}).catch(() => {});
    }

    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getReviews = async (req, res) => {
  try {
    const reviews = await TrainerReview.findByPost(req.params.id);
    res.json(reviews);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
