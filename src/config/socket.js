const { Server } = require('socket.io');
const Chat = require('../modules/chat/chat.model');
const User = require('../modules/users/user.model');
const { saveNotification } = require('../modules/notification/notification.helper');

function initializeSocket(server) {
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join', (userId) => {
      socket.join(String(userId));
      console.log(`User ${userId} joined room`);
    });

    socket.on('join_post', (postId) => {
      socket.join(`post-${postId}`);
      console.log(`Socket joined post room post-${postId}`);
    });

    socket.on('leave_post', (postId) => {
      socket.leave(`post-${postId}`);
    });

    socket.on('send_message', async (data) => {
      try {
        const { sender_id, receiver_id, message } = data;

        const chatMessage = await Chat.create({
          sender_id,
          receiver_id,
          message,
          is_read: false
        });

        io.to(String(receiver_id)).emit('receive_message', chatMessage);
        io.to(String(sender_id)).emit('message_sent', chatMessage);

        const receiverSockets = await io.in(String(receiver_id)).fetchSockets();
        if (receiverSockets.length === 0) {
          const receiver = await User.findById(receiver_id);
          if (receiver) {
            const sender = await User.findById(sender_id);
            const title = `New message from ${sender.name}`;
            const body = message.length > 100 ? message.substring(0, 100) + '...' : message;
            await saveNotification(receiver_id, title, body, 'general', {
              screen: 'Chat',
              params: {
                receiverId: Number(sender_id),
                receiverName: sender.name,
              },
              intent: 'chat_message',
            }).catch(() => {});
          }
        }
      } catch (error) {
        console.error('Error sending message:', error);
        socket.emit('error', { message: error.message });
      }
    });

    socket.on('typing', (data) => {
      const { receiver_id, sender_id, isTyping } = data;
      io.to(receiver_id).emit('user_typing', { sender_id, isTyping });
    });

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
    });
  });

  return io;
}

module.exports = initializeSocket;
