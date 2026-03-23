import { useEffect, useState } from "react";

interface Skill {
	name: string;
	description: string;
	source: string;
	hasEntrypoint: boolean;
}

export function SkillList() {
	const [skills, setSkills] = useState<Skill[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		fetch("/api/skills")
			.then((r) => r.json())
			.then((data) => setSkills(data as Skill[]))
			.finally(() => setLoading(false));
	}, []);

	if (loading) return <p className="text-gray-400 text-sm">Loading skills...</p>;
	if (skills.length === 0) return <p className="text-gray-400 text-sm">No skills loaded.</p>;

	return (
		<div className="space-y-3">
			<h2 className="text-lg font-semibold">Available Skills</h2>
			{skills.map((skill) => (
				<div key={skill.name} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
					<div className="flex items-center gap-2 mb-1">
						<span className="font-medium text-sm">{skill.name}</span>
						{skill.hasEntrypoint && (
							<span className="text-xs bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded">
								script
							</span>
						)}
						<span className="text-xs text-gray-500 ml-auto">{skill.source}</span>
					</div>
					{skill.description && <p className="text-sm text-gray-400">{skill.description}</p>}
				</div>
			))}
		</div>
	);
}
