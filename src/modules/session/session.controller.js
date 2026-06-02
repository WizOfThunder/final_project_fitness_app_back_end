const { Session, Dispute } = require('./session.model');
const { pool } = require('../../config/db');
const { saveNotification } = require('../notification/notification.helper');
const { sendPushNotification } = require('../notification/notification.service');
const ActivityLog = require('../users/activity.model');
const WorkoutPlan = require('../workout/workout.model');

// GET /sessions/hire/:hire_id — get all sessions for a hire (trainer or member)
exports.getHireSessions = async (req, res) => {
  try {
    const hireId = req.params.hire_id;
    const [[hire]] = await pool.query(
      `SELECT th.*, tp.trainer_id FROM trainer_hires th
       JOIN trainer_posts tp ON tp.id = th.post_id
       WHERE th.id = ?`,
      [hireId]
    );
    if (!hire) return res.status(404).json({ error: 'Hire not found' });
    if (hire.member_id !== req.user.id && hire.trainer_id !== req.user.id)
      return res.status(403).json({ error: 'Not your hire' });

    const sessions = await Session.findByHire(hireId);
    const sessionsWithPlans = await Promise.all(
      sessions.map(async session => ({
        ...session,
        session_plan: await WorkoutPlan.findTrainerSessionPlan(session.id),
      }))
    );
    const stats = await Session.getStats(hireId);
    res.json({
      sessions: sessionsWithPlans,
      stats,
      hire: {
        id: hire.id,
        status: hire.status,
        start_date: hire.start_date,
        end_date: hire.end_date,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// PUT /sessions/:session_id/note — trainer sets agenda/note for a session
exports.setSessionNote = async (req, res) => {
  try {
    const { note } = req.body;
    const ok = await Session.setNote(Number(req.params.session_id), req.user.id, note);
    if (!ok) return res.status(403).json({ error: 'Session not found or not yours' });
    res.json({ message: 'Note saved' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// POST /sessions/:session_id/start — trainer starts session, returns code
exports.startSession = async (req, res) => {
  try {
    const code = await Session.trainerStart(Number(req.params.session_id), req.user.id);
    if (!code) return res.status(400).json({ error: 'Cannot start session — not yours, already started, or not upcoming' });

    // Notify member
    const [[session]] = await pool.query(
      `SELECT hs.*, th.id AS hire_id, th.status AS hire_status, th.member_id,
              member.fcm_token AS member_fcm, member.name AS member_name,
              trainer.name AS trainer_name, tp.title AS post_title
       FROM hire_sessions hs
       JOIN trainer_hires th ON th.id = hs.hire_id
        JOIN users member ON member.id = th.member_id
       JOIN trainer_posts tp ON tp.id = th.post_id
       JOIN users trainer ON trainer.id = tp.trainer_id
       WHERE hs.id = ?`,
      [req.params.session_id]
    );
    if (session) {
      const title = 'Session Started!';
      const body = `Your trainer has started the session for "${session.post_title}". Your confirmation code is ${code}. Enter it within 30 minutes to confirm attendance.`;
      await saveNotification(session.member_id, title, body, 'session', {
        screen: 'MemberSessions',
        params: {
          hireId: session.hire_id,
          trainerName: session.trainer_name,
          hireStatus: session.hire_status,
          focusSessionId: session.id,
        },
        sessionId: session.id,
        sessionCode: code,
      });
      if (session.member_fcm) {
        sendPushNotification(session.member_fcm, title, body, {
          type: 'session_started',
          session_id: String(req.params.session_id),
          hire_id: String(session.hire_id),
          hire_status: String(session.hire_status || ''),
          trainer_name: session.trainer_name || '',
          focus_session_id: String(session.id),
          session_code: String(code),
        }).catch(() => {});
      }
    }

    res.json({ code, message: 'Session started. Share this code with your member.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// POST /sessions/:session_id/confirm — member confirms with code
exports.confirmSession = async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code is required' });

    const result = await Session.memberConfirm(Number(req.params.session_id), req.user.id, code);
    if (!result.ok) return res.status(400).json({ error: result.error });

    // Notify trainer
    const [[session]] = await pool.query(
      `SELECT hs.*, tp.trainer_id, u.fcm_token AS trainer_fcm, u.name AS member_name,
              tp.title AS post_title
       FROM hire_sessions hs
       JOIN trainer_hires th ON th.id = hs.hire_id
       JOIN trainer_posts tp ON tp.id = th.post_id
       JOIN users u ON u.id = th.member_id
       WHERE hs.id = ?`,
      [req.params.session_id]
    );
    if (session) {
      const title = 'Attendance Confirmed';
      const body = `${session.member_name} confirmed attendance for "${session.post_title}".`;
      await saveNotification(session.trainer_id, title, body, 'session');
      if (session.trainer_fcm) {
        sendPushNotification(session.trainer_fcm, title, body, { type: 'session_confirmed' }).catch(() => {});
      }

      await ActivityLog.findOneAndUpdate(
        { user_id: req.user.id, date: session.scheduled_date },
        { workout_completed: 1 },
        { upsert: true }
      );

      const { triggerAchievements } = require('../achievement/achievement.helper');
      await triggerAchievements(req.user.id);
    }

    res.json({ message: 'Attendance confirmed!' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// POST /sessions/hire/:hire_id/dispute — member raises a dispute
exports.createDispute = async (req, res) => {
  try {
    const hireId = Number(req.params.hire_id);
    const { reason, description } = req.body;
    if (!reason) return res.status(400).json({ error: 'Reason is required' });

    const [[hire]] = await pool.query(
      `SELECT th.*, member.name AS member_name
       FROM trainer_hires th
       JOIN users member ON member.id = th.member_id
       WHERE th.id = ? AND th.member_id = ? AND th.status = ?`,
      [hireId, req.user.id, 'active']
    );
    if (!hire) return res.status(404).json({ error: 'Active hire not found' });

    // Only one open dispute per hire
    const existing = await Dispute.findOpenByHire(hireId);
    if (existing)
      return res.status(400).json({ error: 'You already have an open dispute for this hire' });

    // Must have reached the first scheduled session date already
    const hasReachedFirstSession = await Session.hasReachedFirstSession(hireId);
    if (!hasReachedFirstSession)
      return res.status(400).json({ error: 'No sessions scheduled yet — disputes can only be raised after the first session date' });

    const dispute = await Dispute.create({
      hire_id: hireId,
      member_id: req.user.id,
      reason,
      description: description || null,
    });

    // Notify admins
    const [admins] = await pool.query("SELECT id, fcm_token FROM users WHERE role = 'admin'");
    const disputeTitle = 'New Hire Dispute';
    const disputeBody = `${hire.member_name || 'A member'} raised a dispute: ${reason}`;
    const notificationData = {
      screen: 'AdminDisputes',
      params: {},
      intent: 'admin_dispute',
      actor_name: hire.member_name || 'Member',
      actor_role: 'member',
      dispute_id: Number(dispute.id),
      event_key: `admin:dispute:${dispute.id}`,
    };
    for (const admin of admins) {
      await saveNotification(admin.id, disputeTitle, disputeBody, 'dispute', notificationData);
      if (admin.fcm_token) {
        sendPushNotification(admin.fcm_token, disputeTitle, disputeBody, {
          type: 'dispute',
          dispute_id: String(dispute.id),
          actor_name: hire.member_name || 'Member',
        }).catch(() => {});
      }
    }

    res.status(201).json(dispute);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// GET /sessions/hire/:hire_id/dispute — get dispute for a hire
exports.getDispute = async (req, res) => {
  try {
    const hireId = Number(req.params.hire_id);
    const [[hire]] = await pool.query(
      `SELECT th.id, th.member_id, tp.trainer_id
       FROM trainer_hires th
       JOIN trainer_posts tp ON tp.id = th.post_id
       WHERE th.id = ?`,
      [hireId]
    );
    if (!hire) return res.status(404).json({ error: 'Hire not found' });

    const canView = req.user.role === 'admin'
      || hire.member_id === req.user.id
      || hire.trainer_id === req.user.id;
    if (!canView) return res.status(403).json({ error: 'Not your hire' });

    const dispute = await Dispute.findLatestByHire(hireId);
    res.json(dispute || null);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// GET /sessions/disputes — admin: get all open disputes
exports.getAllDisputes = async (req, res) => {
  try {
    const disputes = await Dispute.findAllOpen();
    res.json(disputes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// PUT /sessions/disputes/:dispute_id/resolve — admin resolves dispute
exports.resolveDispute = async (req, res) => {
  try {
    const { status, note } = req.body;
    if (!['resolved', 'rejected'].includes(status))
      return res.status(400).json({ error: 'status must be resolved or rejected' });

    const resolved = await Dispute.resolve(req.params.dispute_id, req.user.id, status, note);
    if (!resolved) {
      return res.status(404).json({ error: 'Open dispute not found' });
    }

    if (status === 'resolved') {
      const [endResult] = await pool.query(
        "UPDATE trainer_hires SET status = 'ended', end_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date, early_end_requested_by = NULL, early_end_requested_at = NULL WHERE id = (SELECT hire_id FROM hire_disputes WHERE id = ?) AND status = 'active'",
        [req.params.dispute_id]
      );
      if (endResult.affectedRows > 0) {
        const [[resolvedDispute]] = await pool.query(
          'SELECT hire_id FROM hire_disputes WHERE id = ?',
          [req.params.dispute_id]
        );
        if (resolvedDispute?.hire_id) {
          await Session.trimFutureSessions(resolvedDispute.hire_id);
        }
      }
    }

    // Notify member and trainer
    const [[dispute]] = await pool.query(
      `SELECT hd.*, th.member_id, th.status AS hire_status,
               u.fcm_token AS member_fcm,
               trainer.id AS trainer_id,
               trainer.name AS trainer_name,
               trainer.fcm_token AS trainer_fcm
        FROM hire_disputes hd
        JOIN trainer_hires th ON th.id = hd.hire_id
        JOIN users u ON u.id = hd.member_id
        JOIN trainer_posts tp ON tp.id = th.post_id
        JOIN users trainer ON trainer.id = tp.trainer_id
        WHERE hd.id = ?`,
      [req.params.dispute_id]
    );
    if (dispute) {
      const title = status === 'resolved' ? 'Dispute Resolved' : 'Dispute Rejected';
      const noteSuffix = note ? ` Note: ${note}` : '';
      const memberBody = status === 'resolved'
        ? `Your dispute has been resolved by admin. Your subscription has been ended.${noteSuffix}`
        : `Your dispute was reviewed and rejected.${noteSuffix}`;
      const trainerBody = status === 'resolved'
        ? `A member dispute was resolved by admin. The subscription has been ended.${noteSuffix}`
        : `A member dispute was reviewed by admin and rejected.${noteSuffix}`;

      await saveNotification(dispute.member_id, title, memberBody, 'dispute', {
        screen: 'MemberSessions',
        params: {
          hireId: dispute.hire_id,
          trainerName: dispute.trainer_name,
          hireStatus: dispute.hire_status,
        },
      });
      if (dispute.member_fcm) {
        sendPushNotification(dispute.member_fcm, title, memberBody, {
          type: status === 'resolved' ? 'dispute_resolved' : 'dispute_rejected',
          hire_id: String(dispute.hire_id),
        }).catch(() => {});
      }

      await saveNotification(dispute.trainer_id, title, trainerBody, 'dispute', {
        screen: 'TrainerHireManagement',
        params: {
          initialTab: status === 'resolved' ? 'past' : 'active',
          hireId: dispute.hire_id,
        },
      });
      if (dispute.trainer_fcm) {
        sendPushNotification(dispute.trainer_fcm, title, trainerBody, {
          type: status === 'resolved' ? 'dispute_resolved' : 'dispute_rejected',
          hire_id: String(dispute.hire_id),
        }).catch(() => {});
      }
    }

    res.json({ message: `Dispute ${status}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
