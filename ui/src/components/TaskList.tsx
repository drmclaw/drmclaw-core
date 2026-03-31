import { useEffect, useState } from "react";

interface InMemoryTask {
	id: string;
	prompt: string;
	result: {
		status: string;
		output: string;
		durationMs: number;
		error?: string;
	};
	startedAt: number;
	completedAt: number;
}

interface PersistedTask {
	id: string;
	prompt: string;
	startedAt: string;
}

interface MergedTask {
	id: string;
	prompt: string;
	startedAt: string;
	status?: string;
	durationMs?: number;
}

interface TaskListProps {
	onSelectTask: (taskId: string, prompt: string) => void;
}

export function TaskList({ onSelectTask }: TaskListProps) {
	const [tasks, setTasks] = useState<MergedTask[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		(async () => {
			let inMemory: InMemoryTask[] = [];
			let persisted: PersistedTask[] = [];

			try {
				const res = await fetch("/api/tasks");
				if (res.ok) inMemory = (await res.json()) as InMemoryTask[];
			} catch {
				/* ignore */
			}

			try {
				const res = await fetch("/api/events/tasks");
				if (res.ok) persisted = (await res.json()) as PersistedTask[];
			} catch {
				/* ignore */
			}

			// Merge: prefer in-memory (has result details), supplement with persisted
			const byId = new Map<string, MergedTask>();
			for (const t of persisted) {
				byId.set(t.id, {
					id: t.id,
					prompt: t.prompt,
					startedAt: t.startedAt,
				});
			}
			for (const t of inMemory) {
				byId.set(t.id, {
					id: t.id,
					prompt: t.prompt,
					startedAt: new Date(t.startedAt).toISOString(),
					status: t.result.status,
					durationMs: t.result.durationMs,
				});
			}

			// Sort newest first
			const merged = [...byId.values()].sort(
				(a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
			);
			setTasks(merged);
			setLoading(false);
		})();
	}, []);

	if (loading) return <p className="text-gray-400 text-sm">Loading tasks...</p>;
	if (tasks.length === 0) return <p className="text-gray-400 text-sm">No tasks yet.</p>;

	return (
		<div className="space-y-3">
			<h2 className="text-lg font-semibold">Task History</h2>
			<p className="text-xs text-gray-500">Click a task to replay it in the console.</p>
			{tasks.map((task) => (
				<button
					key={task.id}
					type="button"
					onClick={() => onSelectTask(task.id, task.prompt)}
					className="w-full text-left bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-blue-600 hover:bg-gray-800/50 transition-colors cursor-pointer"
				>
					<div className="flex items-center justify-between mb-2">
						<span className="text-sm text-gray-400 font-mono">{task.id.slice(0, 8)}</span>
						<div className="flex items-center gap-2">
							{task.status && (
								<span
									className={`text-xs px-2 py-0.5 rounded ${
										task.status === "completed"
											? "bg-green-900 text-green-300"
											: "bg-red-900 text-red-300"
									}`}
								>
									{task.status}
								</span>
							)}
							{!task.status && (
								<span className="text-xs px-2 py-0.5 rounded bg-gray-700 text-gray-400">
									persisted
								</span>
							)}
						</div>
					</div>
					<p className="text-sm mb-1">{task.prompt}</p>
					<div className="flex items-center gap-2 text-xs text-gray-500">
						{task.durationMs != null && <span>{task.durationMs}ms</span>}
						<span>{new Date(task.startedAt).toLocaleString()}</span>
					</div>
				</button>
			))}
		</div>
	);
}
