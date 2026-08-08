import type { PrismaClient } from '@prisma/client';

export interface Seeder {
	name: string;
	run(prisma: PrismaClient): Promise<void>;
}
