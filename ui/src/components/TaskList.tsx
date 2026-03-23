import { useEffect, useState } from "react";

interface Task {
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

export function TaskList() {
	const [tasks, setTasks] = useState<Task[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		fetch("/api/tasks")
			.then((r) => r.json())
			.then((data) => setTasks(data as Task[]))
			.finally(() => setLoading(false));
	}, []);

	if (loading) return <p className="text-gray-400 text-sm">Loading tasks...</p>;
	if (tasks.length === 0) return <p className="text-gray-400 text-sm">No tasks yet.</p>;

	return (
		<div className="space-y-3">
			<h2 className="text-lg font-semibold">Recent Tasks</h2>
			{tasks.map((task) => (
				<div key={task.id} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
					<div className="flex items-center justify-between mb-2">
						<span className="text-sm text-gray-400 font-mono">{task.id.slice(0, 8)}</span>
						<span
							className={`text-xs px-2 py-0.5 rounded ${
								task.result.status === "completed"
									? "bg-green-900 text-green-300"
									: "bg-red-900 text-red-300"
							}`}
						>
							{task.result.status}
						</span>
					</div>
					<p className="text-sm mb-1">{task.prompt}</p>
					<p className="text-xs text-gray-500">{task.result.durationMs}ms</p>
				</div>
			))}
		</div>
	);
}
