import type { Joke } from '../../domain/models/joke.model';
import type { JokeRepository } from '../../domain/repositories/joke.repository';

export class ListJokesUseCase {
	constructor(private readonly jokeRepository: JokeRepository) {}

	async execute(): Promise<Joke[]> {
		return this.jokeRepository.findAll();
	}
}
