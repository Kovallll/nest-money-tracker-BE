import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Global prefix
  app.setGlobalPrefix('api');

  // Enable CORS properly
  app.enableCors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Get port and host from environment
  const port = parseInt(process.env.PORT ?? '5000', 10);
  const host = process.env.HOST ?? '0.0.0.0';

  await app.listen(port, host);

  console.log(`🚀 Application is running on: http://${host}:${port}`);
  console.log(`📡 API prefix: /api`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV ?? 'development'}`);
}

bootstrap().catch((err) => {
  console.error('Failed to start application:', err);
  process.exit(1);
});

