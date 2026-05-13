const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });

  try {
    const decoded = jwt.verify(token, 'your_jwt_secret');
    req.userId = decoded.tgId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};