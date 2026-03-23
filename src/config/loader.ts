import { loadConfig } from "c12";
import { type DrMClawConfig, configSchema } from "./schema.js";

/**
 * Load and validate configuration from drmclaw.config.{ts,json} files
 * and environment variables using c12.
 */
export async function loadDrMClawConfig(
	overrides?: Partial<DrMClawConfig>,
): Promise<DrMClawConfig> {
	const { config: raw } = await loadConfig({
		name: "drmclaw",
		defaults: {},
		overrides: overrides ?? {},
	});

	return configSchema.parse(raw);
}
