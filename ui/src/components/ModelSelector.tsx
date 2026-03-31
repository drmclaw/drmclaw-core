interface ModelSelectorProps {
	model: string | null;
	models: string[];
	onModelChange: (model: string) => void;
	disabled?: boolean;
}

export function ModelSelector({ model, models, onModelChange, disabled }: ModelSelectorProps) {
	if (models.length === 0) return null;

	return (
		<select
			value={model ?? ""}
			onChange={(e) => {
				if (e.target.value) onModelChange(e.target.value);
			}}
			disabled={disabled}
			className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500 disabled:opacity-50"
		>
			{!model && <option value="">Select model</option>}
			{models.map((m) => (
				<option key={m} value={m}>
					{m}
				</option>
			))}
		</select>
	);
}
