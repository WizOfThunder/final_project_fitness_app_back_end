# Fitness App Backend API

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file from `.env.example`:
```bash
cp .env.example .env
```

3. Update `.env` with your values

4. Start server:
```bash
npm run dev
```

## API Endpoints

### AUTH
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `GET /api/auth/me` - Get current user

### USERS
- `GET /api/users/:id` - Get user by ID
- `PUT /api/users/:id` - Update user
- `GET /api/users` - Get all users (admin only)

### EXERCISES
- `GET /api/exercises` - Get all exercises
- `GET /api/exercises/:id` - Get exercise by ID
- `POST /api/exercises/sync` - Sync from API Ninjas (admin only)

### AI MODULE
- `POST /api/ai/generate-workout` - Generate workout plan
- `POST /api/ai/generate-diet` - Generate diet plan

### WORKOUT
- `GET /api/workout/my-plan` - Get my workout plans
- `GET /api/workout/:id` - Get workout plan by ID
- `DELETE /api/workout/:id` - Delete workout plan

### VALIDATION (ADMIN)
- `GET /api/validation/pending` - Get pending validations
- `PUT /api/validation/:plan_id` - Validate plan

### CHALLENGE
- `GET /api/challenges` - Get all challenges
- `POST /api/challenges` - Create challenge (admin only)
- `POST /api/challenges/:id/join` - Join challenge
- `GET /api/challenges/my` - Get my challenges

### ACTIVITY (Google Fit)
- `POST /api/activity/sync` - Sync activity data
- `GET /api/activity/history` - Get activity history

### ACHIEVEMENT
- `GET /api/achievements` - Get all achievements
- `GET /api/achievements/my` - Get my achievements

### RANKING
- `GET /api/ranking` - Get top users ranking

### PAYMENT (Midtrans)
- `POST /api/payment/create-transaction` - Create payment transaction
- `POST /api/payment/midtrans-notification` - Webhook for payment notification
- `POST /api/payment/simulate-payment` - Simulate payment (sandbox only)
- `GET /api/payment/status/:order_id` - Get payment status
- `GET /api/payment/my-payments` - Get my payment history

### CHAT (Socket.IO)
- `GET /api/chat/conversations` - Get all conversations
- `GET /api/chat/conversation/:user_id` - Get conversation with user
- `PUT /api/chat/read/:user_id` - Mark messages as read
- Socket Events: `join`, `send_message`, `receive_message`, `typing`

### NOTIFICATION (FCM)
- `POST /api/notification/update-token` - Update FCM token
- `POST /api/notification/send` - Send notification (admin)
- `POST /api/notification/broadcast` - Broadcast to all users (admin)
