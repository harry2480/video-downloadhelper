import type { ReactNode } from 'react';

type Tone = 'neutral' | 'danger';

const TONE_CLASS: Record<Tone, string> = {
	neutral: 'bg-surface-muted text-muted',
	danger: 'bg-surface-muted text-danger',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
	return (
		<span className={`rounded px-1.5 py-0.5 font-medium text-xs ${TONE_CLASS[tone]}`}>
			{children}
		</span>
	);
}
