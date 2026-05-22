const Announcement = require('./announcement.model');
const { sendMulticastNotification } = require('../notification/notification.service');
const { saveNotification } = require('../notification/notification.helper');

// GET /announcements/:post_id — trainer or active/enrolled member
exports.getAnnouncements = async (req, res) => {
  try {
    const postId = req.params.post_id;
    const userId = req.user.id;
    const role = req.user.role;

    if (role === 'trainer') {
      const isOwner = await Announcement.verifyTrainer(postId, userId);
      if (!isOwner) return res.status(403).json({ error: 'Not your post or not a public post' });
    } else {
      const isMember = await Announcement.verifyMember(postId, userId);
      if (!isMember) return res.status(403).json({ error: 'You are not an active member of this post' });
    }

    const announcements = await Announcement.findByPost(postId);
    res.json(announcements);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// POST /announcements/:post_id — trainer only
exports.createAnnouncement = async (req, res) => {
  try {
    const postId = req.params.post_id;
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

    const isOwner = await Announcement.verifyTrainer(postId, req.user.id);
    if (!isOwner) return res.status(403).json({ error: 'Not your post or not a public post' });

    const announcement = await Announcement.create({
      post_id: postId,
      trainer_id: req.user.id,
      message: message.trim(),
    });

    // Get the io instance attached to app and emit to post room
    const io = req.app.get('io');
    if (io) {
      io.to(`post-${postId}`).emit('new_announcement', announcement);
    }

    // FCM multicast + in-app notification to all active/enrolled members
    const members = await Announcement.findMemberTokens(postId);
    const tokens = members.map(m => m.fcm_token).filter(Boolean);
    const title = 'New Announcement';
    const body = message.trim().length > 100 ? message.trim().slice(0, 100) + '...' : message.trim();

    if (tokens.length > 0) {
      sendMulticastNotification(tokens, title, body, {
        type: 'announcement',
        post_id: String(postId),
      }).catch(err => console.error('[Announcement] FCM multicast failed:', err.message));
    }

    for (const member of members) {
      saveNotification(member.user_id, title, body, 'announcement').catch(() => {});
    }

    res.status(201).json(announcement);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
