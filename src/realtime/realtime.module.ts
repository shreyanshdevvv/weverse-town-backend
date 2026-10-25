import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway.js';
import { AuthModule } from '../auth/auth.module.js';
import { RoomsModule } from '../rooms/rooms.module.js';
import { ChatModule } from '../chat/chat.module.js';

@Module({
  imports: [AuthModule, RoomsModule, ChatModule],
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
