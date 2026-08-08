import type { Joke } from '../models/joke.model';

export interface JokeRepository {
	save(joke: Joke): Promise<void>;
	findAll(): Promise<Joke[]>;
}
