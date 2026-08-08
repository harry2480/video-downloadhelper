'use client';

import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from '@/frontend/components/ui/sheet';
import { cn } from '@/lib/utils';
import { Home, Laugh, Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

const navItems = [
	{ href: '/', label: 'TOP', icon: Home },
	{ href: '/jokes', label: 'ジョーク', icon: Laugh },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
	const pathname = usePathname();

	return (
		<nav className="flex flex-col gap-1">
			{navItems.map((item) => {
				const isActive = pathname === item.href;
				return (
					<Link
						key={item.href}
						href={item.href}
						onClick={onNavigate}
						className={cn(
							'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
							isActive
								? 'bg-sidebar-accent text-sidebar-accent-foreground'
								: 'text-sidebar-foreground hover:bg-sidebar-accent/50',
						)}
					>
						<item.icon className="h-4 w-4" />
						{item.label}
					</Link>
				);
			})}
		</nav>
	);
}

export function SidebarNav() {
	const [open, setOpen] = useState(false);

	return (
		<>
			{/* デスクトップサイドバー */}
			<aside className="hidden md:flex md:w-60 md:flex-col md:border-r md:border-sidebar-border md:bg-sidebar">
				<div className="p-4">
					<h2 className="text-lg font-bold text-sidebar-foreground">Product Starter</h2>
				</div>
				<div className="flex-1 px-3 pb-4">
					<NavLinks />
				</div>
			</aside>

			{/* モバイルヘッダー + ハンバーガー */}
			<header className="sticky top-0 z-40 flex h-14 items-center border-b border-sidebar-border bg-sidebar px-4 md:hidden">
				<Sheet open={open} onOpenChange={setOpen}>
					<SheetTrigger asChild>
						<button type="button" className="mr-3 text-sidebar-foreground">
							<Menu className="h-5 w-5" />
							<span className="sr-only">メニューを開く</span>
						</button>
					</SheetTrigger>
					<SheetContent side="left" className="w-60 bg-sidebar p-0">
						<SheetHeader className="border-b border-sidebar-border p-4">
							<SheetTitle className="text-lg font-bold text-sidebar-foreground">
								Product Starter
							</SheetTitle>
						</SheetHeader>
						<div className="px-3 py-4">
							<NavLinks onNavigate={() => setOpen(false)} />
						</div>
					</SheetContent>
				</Sheet>
				<h1 className="text-base font-bold text-sidebar-foreground">Product Starter</h1>
			</header>
		</>
	);
}
