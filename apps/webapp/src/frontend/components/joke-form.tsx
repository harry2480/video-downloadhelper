'use client';

import { Button } from '@/frontend/components/ui/button';
import { Input } from '@/frontend/components/ui/input';
import { Loader2, Sparkles } from 'lucide-react';
import { useActionState, useRef } from 'react';

type ActionState = { error?: string; success?: boolean };

export function JokeForm({
	action,
}: {
	action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}) {
	const formRef = useRef<HTMLFormElement>(null);

	const [state, formAction, isPending] = useActionState(
		async (prev: ActionState, formData: FormData) => {
			const result = await action(prev, formData);
			if (result.success) {
				formRef.current?.reset();
			}
			return result;
		},
		{},
	);

	return (
		<form ref={formRef} action={formAction} className="space-y-3">
			<div className="flex gap-3">
				<Input
					name="theme"
					placeholder="テーマを入力（例: プログラミング）"
					required
					disabled={isPending}
				/>
				<Button type="submit" disabled={isPending}>
					{isPending ? (
						<>
							<Loader2 className="h-4 w-4 mr-1 animate-spin" />
							生成中…
						</>
					) : (
						<>
							<Sparkles className="h-4 w-4 mr-1" />
							生成
						</>
					)}
				</Button>
			</div>
			{state.error && <p className="text-sm text-destructive">{state.error}</p>}
		</form>
	);
}
