import { listJokesUseCase } from '../composition/joke.composition';

export async function jokeListLoader() {
	const jokes = await listJokesUseCase.execute();
	return jokes.map((joke) => ({
		id: joke.id,
		theme: joke.theme,
		content: joke.content,
		createdAt: joke.createdAt.toISOString(),
	}));
}
