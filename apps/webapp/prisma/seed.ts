import { PrismaClient } from '@prisma/client';
import { jokeSeeder } from './seeders/joke.seeder';
import type { Seeder } from './seeders/seeder';

const prisma = new PrismaClient();

const seeders: Seeder[] = [jokeSeeder];

async function main() {
	for (const seeder of seeders) {
		console.log(`[Seed] Running: ${seeder.name}`);
		await seeder.run(prisma);
		console.log(`[Seed] Done: ${seeder.name}`);
	}
}

main()
	.catch((e) => {
		console.error(e);
		process.exit(1);
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
