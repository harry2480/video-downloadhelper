'use server';

import { revalidatePath } from 'next/cache';
import { generateJokeUseCase } from '../composition/joke.composition';

type ActionState = { error?: string; success?: boolean };

export async function generateJokeAction(
	_prev: ActionState,
	formData: FormData,
): Promise<ActionState> {
	const theme = formData.get('theme');
	if (typeof theme !== 'string' || theme.trim().length === 0) {
		return { error: 'テーマを入力してください' };
	}

	try {
		await generateJokeUseCase.execute(theme);
	} catch {
		return { error: 'ジョークの生成に失敗しました。しばらくしてから再度お試しください。' };
	}

	revalidatePath('/jokes');
	return { success: true };
}
