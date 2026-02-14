// api/src/categorizer/categorizer.module.ts
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { CategorizerService } from './categorizer.service';
import { CategorizerController } from './categorizer.controller';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'CATEGORIZER_PACKAGE',
        transport: Transport.GRPC,
        options: {
          package: 'categorizer',
          protoPath: join(__dirname, '../../proto/categorizer.proto'),
          url: process.env.ML_SERVICE_URL || 'ml-service:50051',
        },
      },
    ]),
  ],
  controllers: [CategorizerController],
  providers: [CategorizerService],
  exports: [CategorizerService],
})
export class CategorizerModule {}
