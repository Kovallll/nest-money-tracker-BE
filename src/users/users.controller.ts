import {
  Controller,
  Get,
  Patch,
  Delete,
  Post,
  Body,
  Param,
  UseGuards,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UsersService } from './users.service';
import { UpdateProfileDto, ChangePasswordDto } from './dto';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get(':id/profile')
  async getProfile(@Param('id') id: string, @Req() req: any) {
    this.usersService.ensureCanAccessUser(req.user.id, id);
    return this.usersService.getProfile(id);
  }

  @Patch(':id')
  async updateProfile(@Param('id') id: string, @Body() dto: UpdateProfileDto, @Req() req: any) {
    this.usersService.ensureCanAccessUser(req.user.id, id);
    return this.usersService.updateProfile(id, dto);
  }

  @Post(':id/avatar')
  @UseInterceptors(FileInterceptor('avatar'))
  async uploadAvatar(@Param('id') id: string, @UploadedFile() file: any, @Req() req: any) {
    this.usersService.ensureCanAccessUser(req.user.id, id);
    const avatarUrl = await this.usersService.saveAvatar(id, file);
    return { avatarUrl };
  }

  @Post(':id/change-password')
  async changePassword(
    @Param('id') id: string,
    @Body() body: ChangePasswordDto,
    @Req() req: any,
  ) {
    this.usersService.ensureCanAccessUser(req.user.id, id);
    return this.usersService.changePassword(id, body.oldPassword, body.newPassword);
  }

  @Get(':id/stats')
  async getStats(@Param('id') id: string, @Req() req: any) {
    this.usersService.ensureCanAccessUser(req.user.id, id);
    return this.usersService.getStats(id);
  }

  @Delete(':id')
  async deleteAccount(@Param('id') id: string, @Req() req: any) {
    this.usersService.ensureCanAccessUser(req.user.id, id);
    return this.usersService.deleteAccount(id);
  }
}
