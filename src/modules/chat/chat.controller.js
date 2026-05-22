const Chat = require('./chat.model');

exports.getConversation = async (req, res) => {
  try {
    const { user_id } = req.params;
    const messages = await Chat.find({
      $or: [
        { sender_id: req.user.id, receiver_id: user_id },
        { sender_id: user_id, receiver_id: req.user.id }
      ]
    });
    res.json(messages);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getConversations = async (req, res) => {
  try {
    const conversations = await Chat.getConversations(req.user.id);
    res.json(conversations);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.markAsRead = async (req, res) => {
  try {
    const { user_id } = req.params;
    await Chat.updateMany(
      { sender_id: user_id, receiver_id: req.user.id, is_read: false },
      { is_read: true }
    );
    res.json({ message: 'Messages marked as read' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
