/**
 * drmclaw-core/connectors — connector interface + base implementations.
 *
 * Import via: import { ... } from "drmclaw-core/connectors"
 */

export type { Connector, MessageHandler } from "./connectors/interface.js";
export { WebConnector } from "./connectors/web.js";
export { ConnectorRegistry, createDefaultRegistry } from "./connectors/registry.js";
