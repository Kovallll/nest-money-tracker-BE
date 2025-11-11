import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { TransactionCreate } from '@/types';

@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Get()
  getTransactions() {
    return this.transactionsService.getTransactions();
  }

  @Post()
  createTransaction(@Body() transaction: TransactionCreate) {
    return this.transactionsService.createTransaction(transaction);
  }

  @Patch(':id')
  updateTransaction(@Body() transaction: TransactionCreate, @Param('id') id: number) {
    return this.transactionsService.updateTransaction(Number(id), transaction);
  }

  @Delete(':id')
  deleteTransaction(@Param('id') id: number) {
    return this.transactionsService.deleteTransaction(Number(id));
  }
}
