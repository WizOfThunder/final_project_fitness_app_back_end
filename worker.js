const { connectDB } = require('./src/config/db');
const startCronJobs = require('./src/config/cron');

async function bootstrap() {
  await connectDB();
  startCronJobs();
  console.log('Cron worker started');
}

bootstrap().catch((error) => {
  console.error('Failed to start cron worker:', error);
  process.exit(1);
});
