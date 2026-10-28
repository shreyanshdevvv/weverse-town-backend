import { Global, Module } from '@nestjs/common';
import { AppEventsService } from './events.service.js';

@Global()
@Module({
  providers: [AppEventsService],
  exports: [AppEventsService],
})
export class EventsModule {}
