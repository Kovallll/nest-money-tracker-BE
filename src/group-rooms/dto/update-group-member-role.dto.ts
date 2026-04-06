import { IsIn } from 'class-validator';

export class UpdateGroupMemberRoleDto {
  @IsIn(['admin', 'member'])
  role: 'admin' | 'member';
}
