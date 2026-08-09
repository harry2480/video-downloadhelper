import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'ghost';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: Variant;
	children: ReactNode;
};

const VARIANT_CLASS: Record<Variant, string> = {
	primary: 'bg-primary text-on-primary hover:opacity-90',
	ghost: 'border border-border text-foreground hover:bg-surface-muted',
};

export function Button({ variant = 'primary', className = '', children, ...rest }: Props) {
	return (
		<button
			type="button"
			className={`rounded px-3 py-1.5 font-medium text-sm transition-opacity disabled:opacity-50 ${VARIANT_CLASS[variant]} ${className}`}
			{...rest}
		>
			{children}
		</button>
	);
}
