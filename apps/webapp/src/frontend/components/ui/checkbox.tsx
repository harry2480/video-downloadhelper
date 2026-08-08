'use client';

import { Check } from 'lucide-react';
import { Checkbox } from 'radix-ui';
import type * as React from 'react';

import { cn } from '@/lib/utils';

function CheckboxUI({ className, ...props }: React.ComponentProps<typeof Checkbox.Root>) {
	return (
		<Checkbox.Root
			data-slot="checkbox"
			className={cn(
				'peer size-4 shrink-0 rounded-sm border border-primary shadow-xs transition-shadow outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:border-primary aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
				className,
			)}
			{...props}
		>
			<Checkbox.Indicator className="flex items-center justify-center text-current transition-none">
				<Check className="size-3.5" />
			</Checkbox.Indicator>
		</Checkbox.Root>
	);
}

export { CheckboxUI as Checkbox };
