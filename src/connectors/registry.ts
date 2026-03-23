import type { Connector } from "./interface.js";
import { WebConnector } from "./web.js";

/**
 * Connector registry — loads active connectors from config and provides
 * lookup by name.
 */
export class ConnectorRegistry {
	private connectors = new Map<string, Connector>();

	register(connector: Connector): void {
		this.connectors.set(connector.name, connector);
	}

	get(name: string): Connector | undefined {
		return this.connectors.get(name);
	}

	getAll(): Connector[] {
		return Array.from(this.connectors.values());
	}
}

/** Create the default connector registry with the web connector. */
export function createDefaultRegistry(): {
	registry: ConnectorRegistry;
	webConnector: WebConnector;
} {
	const registry = new ConnectorRegistry();
	const webConnector = new WebConnector();
	registry.register(webConnector);
	return { registry, webConnector };
}
