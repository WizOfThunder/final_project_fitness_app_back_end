const User = require('./user.model');
const {
  normalizeEmail,
  normalizeOptionalText,
  validateProfileUpdateFields,
} = require('./accountValidation');
const { validateProfileMetrics } = require('./profileValidation');
const path = require('path');
const fs = require('fs');
const { saveNotification } = require('../notification/notification.helper');
const { sendPushNotification } = require('../notification/notification.service');
const { pool } = require('../../config/db');

const DEFAULT_PREFS = { weather: true, workout_reminder: true, sync_reminder: true };

exports.getNotificationPrefs = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const prefs = user?.notification_prefs ? JSON.parse(user.notification_prefs) : DEFAULT_PREFS;
    res.json({...DEFAULT_PREFS, ...prefs});
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updateNotificationPrefs = async (req, res) => {
  try {
    const { weather, workout_reminder, sync_reminder } = req.body;
    const user = await User.findById(req.user.id);
    const current = user?.notification_prefs ? JSON.parse(user.notification_prefs) : DEFAULT_PREFS;
    const updated = {
      ...current,
      ...(weather !== undefined && { weather }),
      ...(workout_reminder !== undefined && { workout_reminder }),
      ...(sync_reminder !== undefined && { sync_reminder }),
    };
    await User.findByIdAndUpdate(req.user.id, { notification_prefs: JSON.stringify(updated) });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getPendingTrainers = async (req, res) => {
  try {
    const trainers = (await User.findPendingTrainers()).map(({ password, ...u }) => u);
    res.json(trainers);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.reviewCertification = async (req, res) => {
  try {
    const { status } = req.body;
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be pending, approved, or rejected' });
    }
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role !== 'trainer') return res.status(400).json({ error: 'User is not a trainer' });
    if (user.certification_status === status) {
      return res.json({ message: `Trainer certification already ${status}` });
    }
    await User.findByIdAndUpdate(req.params.id, { certification_status: status });

    try {
      const title =
        status === 'approved'
          ? '✅ Certification Approved'
          : status === 'rejected'
            ? '❌ Certification Rejected'
            : '⏳ Certification Pending Review';
      const body =
        status === 'approved'
          ? 'Your trainer certification has been approved! You can now create posts and accept members.'
          : status === 'rejected'
            ? 'Your trainer certification was rejected. Please contact an admin for more information.'
            : 'Your trainer certification status is now pending review.';
      await saveNotification(user.id, title, body, 'general');
      if (user.fcm_token) sendPushNotification(user.fcm_token, title, body, {type: 'cert_review', status}).catch(() => {});
    } catch (_) {}

    res.json({ message: `Trainer certification ${status}` });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { password, ...rest } = user;
    res.json(rest);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getAllUsers = async (req, res) => {
  try {
    const users = (await User.find()).map(({ password, ...u }) => u);
    res.json(users);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const isAdmin = req.user.role === 'admin';
    if (Number(req.user.id) !== Number(user.id) && !isAdmin) {
      return res.status(403).json({ error: 'Not authorized to edit this user' });
    }

    const {
      name,
      email,
      height,
      weight,
      gender,
      dob,
      goal,
      phone_number,
      profession,
      bio,
      experience_years,
      certification,
    } = req.body;

    const fieldValidationError = validateProfileUpdateFields({
      name,
      email,
      phone_number,
      current_phone_number: user.phone_number,
      role: user.role,
      profession,
      experience_years,
    });
    if (fieldValidationError) {
      return res.status(400).json({ error: fieldValidationError });
    }

    const profileValidationError = validateProfileMetrics({ height, weight, dob });
    if (profileValidationError) {
      return res.status(400).json({ error: profileValidationError });
    }

    const updates = {};
    if (name !== undefined) updates.name = String(name).trim();

    if (email !== undefined) {
      const normalizedEmail = normalizeEmail(email);

      const existing = await User.findOne({ email: normalizedEmail });
      if (existing && Number(existing.id) !== Number(user.id)) {
        return res.status(400).json({ error: 'Email already registered' });
      }

      updates.email = normalizedEmail;
    }

    if (phone_number !== undefined) updates.phone_number = normalizeOptionalText(phone_number);
    if (height !== undefined) updates.height = height;
    if (weight !== undefined) updates.weight = weight;
    if (gender !== undefined) updates.gender = gender;
    if (dob !== undefined) updates.dob = dob;
    if (goal !== undefined) updates.goal = normalizeOptionalText(goal);

    if (user.role === 'trainer') {
      if (profession !== undefined) updates.profession = normalizeOptionalText(profession);
      if (bio !== undefined) updates.bio = normalizeOptionalText(bio);
      if (experience_years !== undefined) {
        updates.experience_years = experience_years === null || String(experience_years).trim() === ''
          ? null
          : Number(experience_years);
      }
      if (certification !== undefined) updates.certification = normalizeOptionalText(certification);
    }

    const updated = await User.findByIdAndUpdate(req.params.id, updates);
    const { password, ...rest } = updated;
    res.json(rest);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.updateStatus = async (req, res) => {
  try {
    const { is_active } = req.body;

    if (typeof is_active !== 'boolean') {
      return res.status(400).json({ error: 'is_active must be a boolean' });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!is_active && Number(user.id) === Number(req.user.id)) {
      return res.status(400).json({ error: 'You cannot ban your own account' });
    }

    const updated = await User.findByIdAndUpdate(req.params.id, {
      is_active,
      deactivated_at: is_active ? null : new Date(),
    });
    const { password, ...rest } = updated;
    res.json(rest);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.updateAvatar = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });

    const user = await User.findById(req.params.id);
    if (user.avatar_url) {
      const oldPath = path.join(__dirname, '../../../', user.avatar_url);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    const avatar_url = `/uploads/avatars/${req.file.filename}`;
    const updated = await User.findByIdAndUpdate(req.params.id, { avatar_url });
    const { password, ...rest } = updated;
    res.json({ message: 'Avatar updated', user: rest });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
