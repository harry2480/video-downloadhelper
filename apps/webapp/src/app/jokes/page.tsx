import { generateJokeAction } from '@/backend/presentation/actions/joke.action';
import { jokeListLoader } from '@/backend/presentation/loaders/joke.loader';
import { JokeForm } from '@/frontend/components/joke-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/frontend/components/ui/card';
import { MessageSquarePlus } from 'lucide-react';

export default async function JokesPage() {
	const jokes = await jokeListLoader();

	return (
		<div className="space-y-8">
			<div className="space-y-1">
				<h1 className="text-2xl font-bold text-foreground">AI ジョークジェネレーター</h1>
				<p className="text-muted-foreground">テーマを入力すると、AIがジョークを生成します</p>
			</div>

			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<MessageSquarePlus className="h-5 w-5" />
						ジョークを生成
					</CardTitle>
				</CardHeader>
				<CardContent>
					<JokeForm action={generateJokeAction} />
				</CardContent>
			</Card>

			{jokes.length > 0 && (
				<div className="space-y-4">
					<h2 className="text-xl font-semibold text-foreground">生成されたジョーク</h2>
					{jokes.map((joke) => (
						<Card key={joke.id}>
							<CardContent className="pt-6">
								<p className="text-sm text-muted-foreground mb-2">テーマ: {joke.theme}</p>
								<p className="text-foreground">{joke.content}</p>
							</CardContent>
						</Card>
					))}
				</div>
			)}
		</div>
	);
}
