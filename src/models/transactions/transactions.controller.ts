import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';
import { CreateTransactionDto, UpdateTransactionDto } from './dto';

@Controller('transactions')
@UseGuards(JwtAuthGuard)
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Get()
  getTransactions() {
    return this.transactionsService.getTransactions();
  }

  @Get('user/:userId')
  getTransactionsByUserId(
    @Param('userId') userId: string,
    @Query('type') type?: 'expense' | 'revenue',
  ) {
    return this.transactionsService.getTransactionsByUserId(userId, type);
  }

  @Get(':id')
  getTransactionById(@Param('id') id: number) {
    return this.transactionsService.getTransactionById(Number(id));
  }

  @Post()
  createTransaction(@Body() dto: CreateTransactionDto) {
    return this.transactionsService.createTransaction(dto);
  }

  @Patch(':id')
  updateTransaction(@Body() dto: UpdateTransactionDto, @Param('id') id: number) {
    return this.transactionsService.updateTransaction(Number(id), dto);
  }

  @Delete(':id')
  deleteTransaction(@Param('id') id: number) {
    return this.transactionsService.deleteTransaction(Number(id));
  }
}

