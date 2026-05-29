const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../users/user.model');
const { validateProfileMetrics } = require('../users/profileValidation');
const { saveNotification } = require('../notification/notification.helper');
const { sendPushNotification } = require('../notification/notification.service');
const { pool } = require('../../config/db');

const isUserInactive = (user) => user?.is_active === false || Number(user?.is_active) === 0;

exports.register = async (req, res) => {
  try {
    const { name, email, password, role, height, weight, gender, dob, goal, phone_number, profession, bio, experience_years, certification, certification_url } = req.body;

    const profileValidationError = validateProfileMetrics({ height, weight, dob });
    if (profileValidationError) {
      return res.status(400).json({ error: profileValidationError });
    }

    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    const hashedPassword = await bcrypt.hash(password, 10);

    const data = { name, email, password: hashedPassword, role: role || 'member', height, weight, gender, dob, goal, phone_number };

    if (role === 'trainer') {
      data.profession = profession || null;
      data.bio = bio || null;
      data.experience_years = experience_years || null;
      data.certification = certification || null;
      data.certification_url = certification_url || null;
      data.certification_status = 'pending';
    } else {
      // non-trainers are auto-approved (status not relevant but set for consistency)
      data.certification_status = 'approved';
    }

    const user = await User.create(data);
    const token = jwt.sign(
      { id: user.id, role: data.role, certification_status: data.certification_status },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    const { password: _, ...rest } = user;
    res.status(201).json({ message: 'User registered', token, user: rest });

    // Notify admins only when a new trainer registers (fire and forget)
    if (data.role === 'trainer') {
      const adminTitle = 'New Trainer Registration';
      const adminBody = `${data.name} registered as a trainer and is awaiting certification review.`;
      pool.query("SELECT id, fcm_token FROM users WHERE role = 'admin'").then(([admins]) => {
        for (const admin of admins) {
          saveNotification(admin.id, adminTitle, adminBody, 'general').catch(() => {});
          if (admin.fcm_token) sendPushNotification(admin.fcm_token, adminTitle, adminBody, {type: 'new_trainer'}).catch(() => {});
        }
      }).catch(() => {});
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (isUserInactive(user)) {
      return res.status(403).json({ error: 'This account has been banned' });
    }
    const token = jwt.sign(
      { id: user.id, role: user.role, certification_status: user.certification_status },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    const { password: _, ...rest } = user;
    res.json({ token, user: rest });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both fields are required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await User.findByIdAndUpdate(req.user.id, { password: hashed });
    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { password, ...rest } = user;
    res.json(rest);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
