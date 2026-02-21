import { Module, Global } from '@nestjs/common';
import { Pool } from 'pg';

export const PG_POOL = 'PG_POOL';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: async () => {
        if (!process.env.DATABASE_URL) {
          throw new Error('КРИТИЧЕСКАЯ ОШИБКА: DATABASE_URL не задан в process.env!');
        }

        const dbUrl = new URL(process.env.DATABASE_URL);

        const pool = new Pool({
          host: dbUrl.hostname,
          port: parseInt(dbUrl.port || '5432', 10),
          user: dbUrl.username,
          password: dbUrl.password,
          database: dbUrl.pathname.replace('/', ''),
          max: 10,
          ssl: {
            rejectUnauthorized: false,
          },
        });

        await pool.query('SELECT 1');
        return pool;
      },
    },
  ],
  exports: [PG_POOL],
})
export class PgModule {}

