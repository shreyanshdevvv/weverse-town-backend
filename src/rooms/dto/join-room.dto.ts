import { IsString, MinLength, MaxLength } from 'class-validator';

export class JoinRoomDto {
  @IsString()
  @MinLength(4, { message: 'Invite code must be at least 4 characters' })
  @MaxLength(20, { message: 'Invite code cannot exceed 20 characters' })
  inviteCode: string;
}
