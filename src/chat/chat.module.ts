import { Module } from '@nestjs/common';
import { ChatService } from './chat.service.js';
import { ChatController } from './chat.controller.js';
import { RoomsModule } from '../rooms/rooms.module.js';

@Module({
  imports: [RoomsModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
