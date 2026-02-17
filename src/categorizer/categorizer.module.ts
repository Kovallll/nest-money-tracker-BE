import { Module } from '@nestjs/common';

import { CategorizerService } from './categorizer.service';
import { CategorizerController } from './categorizer.controller';

@Module({
  controllers: [CategorizerController],
  providers: [CategorizerService],
  exports: [CategorizerService],
})
export class CategorizerModule {}
