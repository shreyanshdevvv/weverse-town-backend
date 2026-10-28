import { IsEnum, IsNotEmpty } from 'class-validator';
import { Role } from '@prisma/client';

export class UpdateMemberRoleDto {
  @IsNotEmpty()
  @IsEnum(Role, {
    message: 'Role must be either MODERATOR or MEMBER',
  })
  role: Role;
}
