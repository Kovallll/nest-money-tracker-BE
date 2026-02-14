import { Module, Global } from '@nestjs/common';
import { Pool } from 'pg';

export const PG_POOL = 'PG_POOL';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: async () => {
        const pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          max: 10,
        });
        await pool.query('SELECT 1'); // healthcheck
        return pool;
      },
    },
  ],
  exports: [PG_POOL],
})
export class PgModule {}
