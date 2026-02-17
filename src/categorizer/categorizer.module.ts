import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { CategorizerService } from './categorizer.service';
import { CategorizerController } from './categorizer.controller';

@Module({
  imports: [
    HttpModule.register({
      timeout: 10000,
      maxRedirects: 5,
    }),
  ],
  controllers: [CategorizerController],
  providers: [CategorizerService],
  exports: [CategorizerService],
})
export class CategorizerModule {}
