import { SidebarNav } from '@/frontend/components/sidebar-nav';
import type { Metadata } from 'next';
import { Noto_Sans_JP } from 'next/font/google';
import './globals.css';

const notoSansJP = Noto_Sans_JP({
	subsets: ['latin'],
	weight: ['400', '500', '600', '700'],
	display: 'swap',
	variable: '--font-noto-sans-jp',
});

export const metadata: Metadata = {
	title: 'Product Starter',
	description: 'Claude Code でプロダクトを素早く構築するスターターキット',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="ja" className={notoSansJP.variable}>
			<body className="font-sans">
				<div className="flex min-h-screen flex-col md:flex-row">
					<SidebarNav />
					<main className="flex-1 overflow-auto">
						<div className="mx-auto max-w-3xl px-4 py-8 md:px-8">{children}</div>
					</main>
				</div>
			</body>
		</html>
	);
}
