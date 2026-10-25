import { IsString, IsNotEmpty } from 'class-validator';

export class UpdateAvatarDto {
  @IsString()
  @IsNotEmpty({ message: 'Avatar cannot be empty' })
  avatar: string;
}
