import { useEffect, useState } from "react";

interface Job {
	id: string;
	name: string;
	enabled: boolean;
	schedule: string;
	prompt: string;
	nextRunAt?: string;
	lastRunAt?: string;
	lastStatus?: string;
	consecutiveErrors: number;
}

export function JobList() {
	const [jobs, setJobs] = useState<Job[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		fetch("/api/jobs")
			.then((r) => r.json())
			.then((data) => setJobs(data as Job[]))
			.finally(() => setLoading(false));
	}, []);

	async function toggleJob(id: string, enabled: boolean) {
		// TODO: implement PATCH /api/jobs/:id when route is added
		setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, enabled } : j)));
	}

	async function runNow(id: string) {
		await fetch(`/api/jobs/${id}/run`, { method: "POST" });
	}

	if (loading) return <p className="text-gray-400 text-sm">Loading jobs...</p>;
	if (jobs.length === 0) return <p className="text-gray-400 text-sm">No scheduled jobs.</p>;

	return (
		<div className="space-y-3">
			<h2 className="text-lg font-semibold">Scheduled Jobs</h2>
			{jobs.map((job) => (
				<div key={job.id} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
					<div className="flex items-center justify-between mb-2">
						<span className="font-medium text-sm">{job.name}</span>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={() => toggleJob(job.id, !job.enabled)}
								className={`text-xs px-2 py-0.5 rounded ${
									job.enabled ? "bg-green-900 text-green-300" : "bg-gray-800 text-gray-500"
								}`}
							>
								{job.enabled ? "enabled" : "disabled"}
							</button>
							<button
								type="button"
								onClick={() => runNow(job.id)}
								className="text-xs px-2 py-0.5 rounded bg-blue-900 text-blue-300 hover:bg-blue-800"
							>
								Run now
							</button>
						</div>
					</div>
					<p className="text-xs text-gray-500 font-mono mb-1">{job.schedule}</p>
					<p className="text-sm text-gray-400">{job.prompt}</p>
					{job.nextRunAt && (
						<p className="text-xs text-gray-600 mt-1">
							Next: {new Date(job.nextRunAt).toLocaleString()}
						</p>
					)}
				</div>
			))}
		</div>
	);
}
