import type { Result } from './result.model';

type JokeError = 'THEME_EMPTY' | 'CONTENT_EMPTY';

export class Joke {
	private constructor(
		public readonly id: string,
		public readonly theme: string,
		public readonly content: string,
		public readonly createdAt: Date,
	) {}

	static create(params: {
		id: string;
		theme: string;
		content: string;
		createdAt?: Date;
	}): Result<Joke, JokeError> {
		const trimmedTheme = params.theme.trim();
		if (trimmedTheme.length === 0) {
			return { success: false, error: 'THEME_EMPTY' };
		}

		const trimmedContent = params.content.trim();
		if (trimmedContent.length === 0) {
			return { success: false, error: 'CONTENT_EMPTY' };
		}

		return {
			success: true,
			value: new Joke(params.id, trimmedTheme, trimmedContent, params.createdAt ?? new Date()),
		};
	}

	static reconstruct(params: {
		id: string;
		theme: string;
		content: string;
		createdAt: Date;
	}): Joke {
		return new Joke(params.id, params.theme, params.content, params.createdAt);
	}
}
