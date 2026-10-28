import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { validateEnv } from './config/env.validation.js';
import { AuthModule } from './auth/auth.module.js';
import { RoomsModule } from './rooms/rooms.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { ChatModule } from './chat/chat.module.js';
import { EventsModule } from './common/events/events.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60000,
        limit: 100,
      },
    ]),
    EventsModule,
    PrismaModule,
    AuthModule,
    RoomsModule,
    RealtimeModule,
    ChatModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
