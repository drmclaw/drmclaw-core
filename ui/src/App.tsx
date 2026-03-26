import { useState } from "react";
import { DebugConsole } from "./components/DebugConsole.js";
import { JobList } from "./components/JobList.js";
import { SkillList } from "./components/SkillList.js";
import { TaskList } from "./components/TaskList.js";
import { useWebSocket } from "./hooks/useWebSocket.js";

type Tab = "console" | "tasks" | "skills" | "jobs";

export function App() {
	const [activeTab, setActiveTab] = useState<Tab>("console");
	const ws = useWebSocket();

	const tabs: { id: Tab; label: string }[] = [
		{ id: "console", label: "Console" },
		{ id: "tasks", label: "Tasks" },
		{ id: "skills", label: "Skills" },
		{ id: "jobs", label: "Jobs" },
	];

	return (
		<div className="min-h-screen flex flex-col">
			<header className="border-b border-gray-800 px-6 py-3 flex items-center gap-6">
				<h1 className="text-lg font-semibold tracking-tight">drmclaw</h1>
				<nav className="flex gap-1">
					{tabs.map((tab) => (
						<button
							key={tab.id}
							type="button"
							onClick={() => setActiveTab(tab.id)}
							className={`px-3 py-1.5 rounded text-sm ${
								activeTab === tab.id
									? "bg-gray-800 text-white"
									: "text-gray-400 hover:text-gray-200"
							}`}
						>
							{tab.label}
						</button>
					))}
				</nav>
				<span className={`ml-auto text-xs ${ws.connected ? "text-green-400" : "text-red-400"}`}>
					{ws.connected ? "connected" : "disconnected"}
				</span>
			</header>

			<main className="flex-1 overflow-hidden">
				{activeTab === "console" && <DebugConsole ws={ws} />}
				{activeTab === "tasks" && (
					<div className="p-6">
						<TaskList />
					</div>
				)}
				{activeTab === "skills" && (
					<div className="p-6">
						<SkillList />
					</div>
				)}
				{activeTab === "jobs" && (
					<div className="p-6">
						<JobList />
					</div>
				)}
			</main>
		</div>
	);
}
