import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule, isObserveEnabled, ObserveInstrument } from './app.module.js';
import { createValidationPipe } from './common/validation.js';
import { helmetOptions } from './security/helmet.config.js';

async function bootstrap() {
  const bootstrapLogger = new NestLogger('Bootstrap');
  const app = await NestFactory.create(AppModule, {
    ...(isObserveEnabled() ? { instrument: ObserveInstrument } : {}),
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.use(helmet(helmetOptions));
  // Behind a reverse proxy, set TRUST_PROXY (e.g. 1) so per-IP sign-up limits see the
  // real client IP instead of the proxy's.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) {
    app.getHttpAdapter().getInstance().set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
  }
  app.useGlobalPipes(createValidationPipe());
  const config = app.get(ConfigService);
  const corsOrigins = config.get<string>('CORS_ORIGIN', '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    origin: corsOrigins.includes('*') ? true : corsOrigins,
    credentials: !corsOrigins.includes('*'),
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Kaapy API')
    .setDescription('API documentation for the Kaapy backend')
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'access-token',
    )
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'refresh-token',
    )
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, swaggerDocument, {
    jsonDocumentUrl: 'docs-json',
  });

  

  await app.listen(process.env.PORT ?? 3000);
  bootstrapLogger.log(
    `Backend listening on ${await app.getUrl()}; Google route expected at POST /auth/google`,
  );
}
await bootstrap();
