const User = require('../modules/users/user.model');

const certificationMiddleware = async (req, res, next) => {
  if (req.user.role !== 'trainer') return next();
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.certification_status !== 'approved') {
      return res.status(403).json({
        error: 'Trainer certification pending approval',
        certification_status: user.certification_status,
      });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = certificationMiddleware;
