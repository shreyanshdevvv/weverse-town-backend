import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway.js';

@Module({
  providers: [RealtimeGateway]
})
export class RealtimeModule {}
