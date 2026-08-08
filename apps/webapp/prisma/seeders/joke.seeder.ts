import type { PrismaClient } from '@prisma/client';
import type { Seeder } from './seeder';

const JOKE_ID = 'seed-joke-001';

const jokes = [
	{
		id: JOKE_ID,
		theme: 'プログラミング',
		content:
			'プログラマーに「家に帰る途中で牛乳を1つ買ってきて。卵があったら6つ買ってきて」と頼んだら、牛乳を6つ買ってきた。卵があったから。',
	},
];

export const jokeSeeder: Seeder = {
	name: 'Joke',
	async run(prisma: PrismaClient): Promise<void> {
		for (const joke of jokes) {
			await prisma.joke.upsert({
				where: { id: joke.id },
				update: { theme: joke.theme, content: joke.content },
				create: joke,
			});
		}
	},
};
