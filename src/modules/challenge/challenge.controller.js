const { Challenge, UserChallenge, CompletionRequest, normalizeChallengeRow } = require('./challenge.model');
const { triggerAchievements } = require('../achievement/achievement.helper');
const { saveNotification } = require('../notification/notification.helper');
const { sendPushNotification } = require('../notification/notification.service');
const User = require('../users/user.model');
const { pool } = require('../../config/db');

const WIB_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jakarta',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function getWibNowParts() {
  return Object.fromEntries(
    WIB_DATE_TIME_FORMATTER.formatToParts(new Date()).map((part) => [part.type, part.value])
  );
}

function getCurrentWibDateString() {
  const parts = getWibNowParts();
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeTimeString(value) {
  if (!value) return null;

  const [hours = '00', minutes = '00', seconds = '00'] = String(value).split(':');
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function getCurrentWibTimeString() {
  const parts = getWibNowParts();
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

function hasTimePassedWib(timeStr) {
  const normalized = normalizeTimeString(timeStr);
  if (!normalized) return true;
  return getCurrentWibTimeString() >= normalized;
}

async function notifyAdmins(title, body, type, data, pushData) {
  try {
    const [admins] = await pool.query("SELECT id, fcm_token FROM users WHERE role = 'admin'");

    for (const admin of admins) {
      await saveNotification(admin.id, title, body, type, data);
      if (admin.fcm_token) {
        sendPushNotification(admin.fcm_token, title, body, pushData).catch(() => {});
      }
    }
  } catch (error) {
    console.error('[Challenge] Failed to notify admins:', error.message);
  }
}

exports.getChallenges = async (req, res) => {
  try {
    const challenges = await Challenge.find();
    res.json(challenges);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getChallengeById = async (req, res) => {
  try {
    const [[row]] = await pool.query(
      `SELECT c.*, u.name as creator_name, u.role as creator_role,
              COUNT(uc.id) as participant_count
       FROM challenges c
       JOIN users u ON u.id = c.created_by
       LEFT JOIN user_challenges uc ON uc.challenge_id = c.id
       WHERE c.id = ?
       GROUP BY c.id, u.id`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Challenge not found' });
    res.json(normalizeChallengeRow(row));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getCreatedChallenges = async (req, res) => {
  try {
    const challenges = await Challenge.findCreated(req.user.id, req.user.role);
    res.json(challenges);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.createChallenge = async (req, res) => {
  try {
    const status = req.user.role === 'admin' ? 'active' : 'pending';
    const challenge = await Challenge.create({ ...req.body, created_by: req.user.id, status });

    if (status === 'pending') {
      try {
        const creator = await User.findById(req.user.id);
        const actorName = creator?.name || 'A trainer';
        const title = 'Challenge Submitted for Approval';
        const body = `${actorName} submitted "${challenge.title}" for approval.`;
        await notifyAdmins(
          title,
          body,
          'admin_challenge_submission',
          {
            screen: 'ManageChallenge',
            params: { initialTab: 'pending' },
            intent: 'admin_challenge_submission',
            actor_name: actorName,
            actor_role: 'trainer',
            challenge_id: Number(challenge.id),
            event_key: `admin:challenge_submission:${challenge.id}`,
          },
          {
            type: 'admin_challenge_submission',
            challenge_id: String(challenge.id),
            actor_name: actorName,
          },
        );
      } catch (_) {}
    }

    res.status(201).json(challenge);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.reviewChallenge = async (req, res) => {
  try {
    const { action, note } = req.body;
    if (!['active', 'rejected'].includes(action)) return res.status(400).json({ error: 'action must be active or rejected' });

    const challenge = await Challenge.findById(req.params.id);
    if (!challenge) return res.status(404).json({ error: 'Challenge not found' });

    await pool.query('UPDATE challenges SET status = ?, validation_note = ? WHERE id = ?', [action, note || null, req.params.id]);

    try {
      const trainer = await User.findById(challenge.created_by);
      if (trainer) {
        const approved = action === 'active';
        const notifTitle = approved ? '✅ Challenge Approved' : '❌ Challenge Rejected';
        const notifMessage = approved
          ? `Your challenge "${challenge.title}" has been approved and is now live!`
          : `Your challenge "${challenge.title}" was rejected.${note ? ` Reason: ${note}` : ''}`;
        await saveNotification(
          trainer.id,
          notifTitle,
          notifMessage,
          'challenge_review',
          {
            screen: 'ChallengeDetail',
            params: {challengeId: challenge.id},
          },
        );
        if (trainer.fcm_token) {
          await sendPushNotification(
            trainer.fcm_token, notifTitle, notifMessage,
            { type: 'challenge_review', challenge_id: String(challenge.id), status: action }
          ).catch(() => {});
        }
      }
    } catch (_) {}

    res.json({ message: `Challenge ${action === 'active' ? 'approved' : 'rejected'}` });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.joinChallenge = async (req, res) => {
  try {
    const existing = await UserChallenge.findByUserAndChallenge(req.user.id, req.params.id);
    if (existing) return res.status(400).json({ error: 'Already joined this challenge' });
    const challenge = await Challenge.findById(req.params.id);
    if (!challenge) return res.status(404).json({ error: 'Challenge not found' });
    if (challenge.created_by === req.user.id) return res.status(400).json({ error: 'You cannot join your own challenge' });
    const today = getCurrentWibDateString();
    if (challenge.end_date && challenge.end_date < today) {
      return res.status(400).json({ error: 'Challenge has already ended' });
    }

    if (challenge.challenge_type !== 'auto' && challenge.start_date) {
      const eventStarted = challenge.start_date < today || (
        challenge.start_date === today && (
          !challenge.event_start_time || hasTimePassedWib(challenge.event_start_time)
        )
      );
      if (eventStarted) {
        return res.status(400).json({ error: 'Registration is closed — this event has already started', code: 'EVENT_STARTED' });
      }
    }

    if (challenge.max_participants) {
      const [[{cnt}]] = await pool.query(
        'SELECT COUNT(*) as cnt FROM user_challenges WHERE challenge_id = ?',
        [req.params.id]
      );
      if (cnt >= challenge.max_participants) {
        return res.status(400).json({ error: 'Challenge is full', code: 'CHALLENGE_FULL' });
      }
    }
    const userChallenge = await UserChallenge.create({
      user_id: req.user.id,
      challenge_id: req.params.id,
    });
    res.json(userChallenge);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getMyChallenges = async (req, res) => {
  try {
    const challenges = await UserChallenge.find({ user_id: req.user.id });
    res.json(challenges);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.submitCompletion = async (req, res) => {
  try {
    const userChallengeId = req.params.userChallengeId;

    const uc = await UserChallenge.findById(userChallengeId);
    if (!uc) return res.status(404).json({ error: 'User challenge not found' });
    if (uc.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (uc.status === 'completed') return res.status(400).json({ error: 'Already completed' });

    const challenge = await Challenge.findById(uc.challenge_id);
    if (!challenge) return res.status(404).json({ error: 'Challenge not found' });

    if (challenge.challenge_type === 'auto') {
      if (uc.current_value < challenge.target_value) {
        return res.status(400).json({ error: 'Target not yet reached' });
      }
      await UserChallenge.complete(userChallengeId);
      await triggerAchievements(req.user.id);
      return res.json({ message: 'Challenge completed! Reward granted.' });
    }

    if (challenge.challenge_type !== 'auto') {
      const today = getCurrentWibDateString();
      if (challenge.end_date) {
        const submissionAllowed = challenge.end_date < today || (
          challenge.end_date === today && !!challenge.event_end_time && hasTimePassedWib(challenge.event_end_time)
        );
        if (!submissionAllowed) {
          return res.status(400).json({ error: 'Submission opens after the event ends' });
        }
      }
    }

    const alreadyPending = await CompletionRequest.existsPending(userChallengeId);
    if (alreadyPending) return res.status(400).json({ error: 'Completion request already pending' });

    const proofPath = req.file ? `/uploads/proofs/${req.file.filename}` : (req.body.proof_url || null);

    const request = await CompletionRequest.create({
      user_challenge_id: userChallengeId,
      user_id: req.user.id,
      challenge_id: uc.challenge_id,
      proof_url: proofPath,
      note: req.body.note || null,
    });

    try {
      const [member, creator] = await Promise.all([
        User.findById(req.user.id),
        User.findById(challenge.created_by),
      ]);

      if (creator?.role === 'admin') {
        const actorName = member?.name || 'A member';
        const title = 'Challenge Review Needed';
        const body = `${actorName} submitted proof for "${challenge.title}".`;
        await notifyAdmins(
          title,
          body,
          'admin_challenge_review',
          {
            screen: 'ManageChallenge',
            params: { initialTab: 'reviews' },
            intent: 'admin_challenge_review',
            actor_name: actorName,
            actor_role: 'member',
            challenge_id: Number(challenge.id),
            request_id: Number(request.id),
            event_key: `admin:challenge_review:${request.id}`,
          },
          {
            type: 'admin_challenge_review',
            challenge_id: String(challenge.id),
            request_id: String(request.id),
            actor_name: actorName,
          },
        );
      }
    } catch (_) {}

    res.status(201).json(request);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.bulkApproveRequests = async (req, res) => {
  try {
    const { challenge_id } = req.body;
    if (!challenge_id) return res.status(400).json({ error: 'challenge_id is required' });

    const [pending] = await pool.query(
      `SELECT cr.id, cr.user_challenge_id, cr.user_id FROM completion_requests cr
       WHERE cr.challenge_id = ? AND cr.status = 'pending'`,
      [challenge_id]
    );
    if (!pending.length) return res.json({ message: 'No pending requests', approved: 0 });

    for (const req_ of pending) {
      await CompletionRequest.review(req_.id, 'approved', req.user.id);
      await UserChallenge.complete(req_.user_challenge_id);
      await triggerAchievements(req_.user_id);
      try {
        const [[memberRow]] = await pool.query(
          `SELECT u.fcm_token, c.title AS challenge_title
           FROM users u, challenges c
           WHERE u.id = ? AND c.id = ?`,
          [req_.user_id, challenge_id]
        );
        if (memberRow) {
          const title = '🏆 Completion Approved!';
          const body = `Your completion for "${memberRow.challenge_title}" was approved. Reward granted!`;
          await saveNotification(req_.user_id, title, body, 'achievement');
          if (memberRow.fcm_token) sendPushNotification(memberRow.fcm_token, title, body, {type: 'challenge_review', status: 'approved'}).catch(() => {});
        }
      } catch (_) {}
    }

    res.json({ message: `Bulk approved ${pending.length} requests`, approved: pending.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getPendingRequests = async (req, res) => {
  try {
    const requests = await CompletionRequest.findPending();
    res.json(requests);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.reviewRequest = async (req, res) => {
  try {
    const { status } = req.body; // 'approved' or 'rejected'
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be approved or rejected' });
    }

    const request = await CompletionRequest.findById(req.params.requestId);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'Request already reviewed' });

    await CompletionRequest.review(request.id, status, req.user.id);

    if (status === 'approved') {
      await UserChallenge.complete(request.user_challenge_id);
      await triggerAchievements(request.user_id);
    }

    try {
      const [[memberRow]] = await pool.query(
        `SELECT u.fcm_token, c.title AS challenge_title
         FROM users u, challenges c
         WHERE u.id = ? AND c.id = ?`,
        [request.user_id, request.challenge_id]
      );
      if (memberRow) {
        const title = status === 'approved' ? '🏆 Completion Approved!' : '❌ Completion Rejected';
        const body = status === 'approved'
          ? `Your completion for "${memberRow.challenge_title}" was approved. Reward granted!`
          : `Your completion for "${memberRow.challenge_title}" was not approved. Try again!`;
        await saveNotification(request.user_id, title, body, 'achievement');
        if (memberRow.fcm_token) sendPushNotification(memberRow.fcm_token, title, body, {type: 'challenge_review', status}).catch(() => {});
      }
    } catch (_) {}

    res.json({ message: `Request ${status}` });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
