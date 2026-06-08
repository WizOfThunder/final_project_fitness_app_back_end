const { PORT } = require('./src/config/env');
const app = require('./src/app');
const { connectDB } = require('./src/config/db');
const http = require('http');
const initializeSocket = require('./src/config/socket');

const server = http.createServer(app);
const io = initializeSocket(server);
app.set('io', io);

async function bootstrap() {
  await connectDB();

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error('Failed to start web server:', error);
  process.exit(1);
});
