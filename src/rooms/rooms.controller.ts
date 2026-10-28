import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { RoomsService } from './rooms.service.js';
import { CreateRoomDto } from './dto/create-room.dto.js';
import { UpdateRoomDto } from './dto/update-room.dto.js';
import { JoinRoomDto } from './dto/join-room.dto.js';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';

@Controller('rooms')
@UseGuards(JwtAuthGuard)
export class RoomsController {
  constructor(private readonly roomsService: RoomsService) {}

  @Post()
  create(@CurrentUser() user: any, @Body() dto: CreateRoomDto) {
    return this.roomsService.create(user.id, dto);
  }

  @Post('join')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  join(@CurrentUser() user: any, @Body() dto: JoinRoomDto) {
    return this.roomsService.join(user.id, dto);
  }

  @Get('my')
  findMyRooms(@CurrentUser() user: any) {
    return this.roomsService.findMyRooms(user.id);
  }

  @Get(':id')
  findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: any,
  ) {
    return this.roomsService.findOne(id, user.id);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: any,
    @Body() dto: UpdateRoomDto,
  ) {
    return this.roomsService.update(id, user.id, dto);
  }

  @Delete(':id')
  delete(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: any,
  ) {
    return this.roomsService.delete(id, user.id);
  }

  @Post(':id/leave')
  leave(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: any,
  ) {
    return this.roomsService.leave(id, user.id);
  }

  @Post(':id/regenerate-invite')
  regenerateInviteCode(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: any,
  ) {
    return this.roomsService.regenerateInviteCode(id, user.id);
  }

  @Delete(':id/members/:memberId')
  kickMember(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('memberId', new ParseUUIDPipe()) memberId: string,
    @CurrentUser() user: any,
  ) {
    return this.roomsService.kickMember(id, user.id, memberId);
  }

  @Patch(':id/members/:memberId/role')
  updateMemberRole(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('memberId', new ParseUUIDPipe()) memberId: string,
    @CurrentUser() user: any,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.roomsService.updateMemberRole(id, user.id, memberId, dto.role);
  }
}
