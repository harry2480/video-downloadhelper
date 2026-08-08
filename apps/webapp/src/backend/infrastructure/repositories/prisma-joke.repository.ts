import { Joke } from '../../domain/models/joke.model';
import type { JokeRepository } from '../../domain/repositories/joke.repository';
import { prisma } from '../db/prisma-client';

export class PrismaJokeRepository implements JokeRepository {
	async save(joke: Joke): Promise<void> {
		await prisma.joke.create({
			data: {
				id: joke.id,
				theme: joke.theme,
				content: joke.content,
				createdAt: joke.createdAt,
			},
		});
	}

	async findAll(): Promise<Joke[]> {
		const records = await prisma.joke.findMany({
			orderBy: { createdAt: 'desc' },
		});

		return records.map((record) =>
			Joke.reconstruct({
				id: record.id,
				theme: record.theme,
				content: record.content,
				createdAt: record.createdAt,
			}),
		);
	}
}
