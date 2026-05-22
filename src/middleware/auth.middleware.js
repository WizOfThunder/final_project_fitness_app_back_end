const jwt = require('jsonwebtoken');
const User = require('../modules/users/user.model');

const isUserInactive = user => user?.is_active === false || Number(user?.is_active) === 0;

const authMiddleware = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ message: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    if (isUserInactive(user)) {
      return res.status(403).json({ message: 'Account has been banned' });
    }

    req.user = {
      id: user.id,
      role: user.role,
      certification_status: user.certification_status,
      email: user.email,
      name: user.name,
    };
    next();
  } catch (error) {
    res.status(401).json({ message: 'Invalid token' });
  }
};

module.exports = authMiddleware;
