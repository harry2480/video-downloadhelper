import { Card, CardContent, CardHeader, CardTitle } from '@/frontend/components/ui/card';
import { Laugh, Lightbulb, Rocket, Wand2 } from 'lucide-react';

export default function HomePage() {
	return (
		<div className="space-y-8">
			<div className="space-y-3">
				<h1 className="text-2xl font-bold text-foreground">Product Starter</h1>
				<p className="text-muted-foreground">
					Claude Code への指示だけでプロダクトを素早く構築できるスターターキットです。
				</p>
			</div>

			<div className="grid gap-4 sm:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2 text-base">
							<Wand2 className="h-5 w-5 text-primary" />
							自然言語で開発
						</CardTitle>
					</CardHeader>
					<CardContent>
						<p className="text-sm text-muted-foreground">
							「〇〇な機能を作って」と指示するだけで、設計ルールに従ったコードが自動生成されます。
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2 text-base">
							<Lightbulb className="h-5 w-5 text-primary" />
							透明な DDD 設計
						</CardTitle>
					</CardHeader>
					<CardContent>
						<p className="text-sm text-muted-foreground">
							内部的に DDD 4層構造を維持。利用者は設計知識不要で、品質の高いコードが生まれます。
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2 text-base">
							<Rocket className="h-5 w-5 text-primary" />
							すぐにデプロイ
						</CardTitle>
					</CardHeader>
					<CardContent>
						<p className="text-sm text-muted-foreground">
							Vercel + Supabase
							で本番環境へ即デプロイ。インフラの心配なくプロダクト開発に集中できます。
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2 text-base">
							<Laugh className="h-5 w-5 text-primary" />
							サンプル機能付き
						</CardTitle>
					</CardHeader>
					<CardContent>
						<p className="text-sm text-muted-foreground">
							AIジョーク生成機能がサンプルとして同梱。実装パターンのリファレンスとしてご活用ください。
						</p>
					</CardContent>
				</Card>
			</div>

			<Card className="bg-primary-bg border-primary/20">
				<CardContent className="pt-6">
					<h2 className="text-base font-semibold text-foreground mb-2">はじめ方</h2>
					<ol className="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
						<li>
							<code className="text-xs bg-muted px-1 py-0.5 rounded">pnpm dev</code>{' '}
							で開発サーバーを起動
						</li>
						<li>Claude Code に作りたい機能を伝える</li>
						<li>
							<code className="text-xs bg-muted px-1 py-0.5 rounded">pnpm verify</code>{' '}
							で品質チェック
						</li>
					</ol>
				</CardContent>
			</Card>
		</div>
	);
}
